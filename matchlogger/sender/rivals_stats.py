"""Stats-diff source for the station sender (stdlib-only, freezes to .exe).

A no-injection alternative to the MatchLogger UE4SS mod: instead of the mod
reading the results screen, watch Rivals2_StatsSaveSlot.sav (which flushes per
game, in real time) and the Replays folder, diff the save to recover the winner
/ loser / characters / per-game stats, use the replay filename for timestamp +
slots + the GameN set counter, and write the SAME files the mod does into the
sender's own output dir. The sender's normal forwarding then POSTs them.

Validated: parse_stats() matches the site's uesave wasm exactly (all values).
"""
import os
import re
import struct
import time


# ---------------------------------------------------------------------------
# GVAS reader (UE5.4+ recursive property-type-name format), read-only.
# property = name:FString type:TypeName size:int32 guid:u8 value
# TypeName = name:FString count:int32 params:TypeName[]
# ---------------------------------------------------------------------------
class _Reader:
    def __init__(self, b):
        self.b = b
        self.i = 0

    def u8(self):
        v = self.b[self.i]; self.i += 1; return v

    def i32(self):
        v = struct.unpack_from('<i', self.b, self.i)[0]; self.i += 4; return v

    def f32(self):
        v = struct.unpack_from('<f', self.b, self.i)[0]; self.i += 4; return v

    def fstr(self):
        n = self.i32()
        if n == 0:
            return ""
        if n > 0:
            s = self.b[self.i:self.i + n - 1]; self.i += n; return s.decode('latin1')
        n = -n
        s = self.b[self.i:self.i + n * 2 - 2]; self.i += n * 2
        return s.decode('utf-16-le')


def _read_type(r):
    name = r.fstr()
    count = r.i32()
    return (name, [_read_type(r) for _ in range(count)])


def _read_scalar(r, typename):
    if typename in ('StrProperty', 'NameProperty', 'EnumProperty'):
        return r.fstr()
    if typename == 'IntProperty':
        return r.i32()
    if typename == 'FloatProperty':
        return r.f32()
    if typename == 'ByteProperty':
        return r.u8()
    if typename == 'StructProperty':
        return _read_props(r)
    raise ValueError('unhandled scalar ' + typename)


def _read_value(r, typ):
    name, params = typ
    if name in ('StrProperty', 'NameProperty', 'EnumProperty', 'ByteProperty'):
        return r.fstr()
    if name == 'IntProperty':
        return r.i32()
    if name == 'FloatProperty':
        return r.f32()
    if name == 'StructProperty':
        return _read_props(r)
    if name == 'ArrayProperty':
        count = r.i32()
        inner = params[0][0] if params else 'StructProperty'
        return [_read_props(r) if inner == 'StructProperty' else _read_scalar(r, inner)
                for _ in range(count)]
    if name == 'MapProperty':
        ktype, vtype = params[0][0], params[1][0]
        r.i32()  # num keys to remove
        count = r.i32()
        return [(_read_scalar(r, ktype), _read_scalar(r, vtype)) for _ in range(count)]
    raise ValueError('unhandled value ' + name)


def _read_props(r):
    props = {}
    while True:
        name = r.fstr()
        if name in ('None', ''):
            break
        typ = _read_type(r)
        if typ[0] == 'BoolProperty':
            r.i32()            # size
            props[name] = bool(r.u8())
            r.u8()             # guid flag
            continue
        r.i32()                # size
        r.u8()                 # guid flag
        props[name] = _read_value(r, typ)
    return props


# Per-character stat maps we diff. Right column = per-match field name.
STAT_FIELDS = [
    ('MatchesByCharacter', 'matches'), ('WinsByCharacter', 'wins'), ('LossesByCharacter', 'losses'),
    ('KOsByCharacter', 'kos'), ('DeathsByCharacter', 'deaths'), ('FallsByCharacter', 'falls'),
    ('DamageDealtByCharacter', 'damageDealt'), ('DamageTakenByCharacter', 'damageTaken'),
    ('ParryAttemptsByCharacter', 'parryAttempts'), ('ParrySuccessesByCharacter', 'parrySuccesses'),
    ('GrabAttemptsByCharacter', 'grabAttempts'), ('GrabSuccessesByCharacter', 'grabSuccesses'),
    ('PummelAttemptsByCharacter', 'pummelAttempts'), ('PummelSuccessesByCharacter', 'pummelSuccesses'),
]
_CATS = [c for c, _ in STAT_FIELDS]
_BOOKKEEPING = {'MatchesByCharacter', 'WinsByCharacter', 'LossesByCharacter'}
SYNTHETIC = {'ALL TAGS', 'CUM'}

# The save/replays store characters as the first 3 letters of the ImmutableName
# (verified against the game pak's Characters/<Name>/ folders). Full names:
CHARACTERS = {
    'Abs': 'Absa', 'Cla': 'Clairen', 'Eta': 'Etalus', 'Fle': 'Fleet',
    'For': 'Forsburn', 'Gal': 'Galvan', 'Kra': 'Kragg', 'Lar': 'La Reina',
    'Lox': 'Loxodont', 'May': 'Maypul', 'Oly': 'Olympia', 'Orc': 'Orcane',
    'Ran': 'Ranno', 'Sla': 'Slade', 'Wra': 'Wrastor', 'Zet': 'Zetterburn',
    'Random': 'Random',
}


def char_full(abbrev):
    """3-letter code -> full character name (falls back to the code)."""
    return CHARACTERS.get(abbrev, abbrev)


def format_set_rows(snapshot, aliases=None):
    """Flatten a machine snapshot into display rows (one per player), shared by
    the console scoreboard and the GUI table. Chronological; live set last.
    Each row: {startEpoch, first, complete, tag, gg, char, wins, won}."""
    aliases = aliases or {}
    sets = list(snapshot.get('history', []))
    live = snapshot.get('live')
    if live:
        sets.append(live)
    rows = []
    for s in sets:
        for i, p in enumerate(s['players']):
            rows.append({
                'startEpoch': s['startEpoch'], 'first': i == 0, 'complete': s['complete'],
                'tag': p['tag'], 'gg': aliases.get(p['tag'], ''),
                'char': char_full(p['char']), 'wins': p['wins'], 'won': p.get('won', False),
            })
    return rows


def parse_stats(data):
    """{ 'tag|char|mode|Category': number } for every real player-tag stat."""
    r = _Reader(data)
    p = data.find(b'AllPlayerTagStats\x00')
    if p < 0:
        return {}
    r.i = data.rfind(struct.pack('<i', 18), 0, p)
    root = _read_props(r)
    flat = {}
    for tag in root.get('AllPlayerTagStats', []):
        name = tag.get('PlayerTagName')
        if name is None or name in SYNTHETIC:
            continue
        for cat in _CATS:
            arr = tag.get(cat)
            if not isinstance(arr, list):
                continue
            for (char, modestats) in arr:
                values = modestats.get('Values', []) if isinstance(modestats, dict) else []
                for (modekey, val) in values:
                    mode = str(modekey).split('::')[-1]
                    flat['%s|%s|%s|%s' % (name, char, mode, cat)] = val
    return flat


def tag_names(flat):
    return sorted({k.split('|')[0] for k in flat})


# ---------------------------------------------------------------------------
# diff + de-alias + game result
# ---------------------------------------------------------------------------
def diff(prev, nxt):
    buckets = {}
    for key, val in nxt.items():
        d = val - prev.get(key, 0)
        if d == 0:
            continue
        tag, char, mode, cat = key.split('|')
        buckets.setdefault('%s|%s|%s' % (tag, char, mode), {})[cat] = d
    return buckets


def _dealias_random(items):
    real = set()
    for bk, _ in items:
        tag, char, mode = bk.split('|')
        if char != 'Random':
            real.add('%s|%s' % (tag, mode))
    return [(bk, d) for bk, d in items
            if not (bk.split('|')[1] == 'Random' and
                    '%s|%s' % (bk.split('|')[0], bk.split('|')[2]) in real)]


def to_game_result(buckets):
    """{'mode','winners':[{tag,char,stats}],'losers':[...]} or None if not a match."""
    rows = _dealias_random(list(buckets.items()))

    def side(pred):
        out = []
        for bk, d in rows:
            if not pred(d):
                continue
            tag, char, mode = bk.split('|')
            stats = {field: int(round(d[cat])) for cat, field in STAT_FIELDS
                     if cat in d and cat not in _BOOKKEEPING}
            out.append({'tag': tag, 'char': char, 'mode': mode, 'stats': stats})
        return out

    winners = side(lambda d: d.get('WinsByCharacter', 0) > 0)
    losers = side(lambda d: d.get('LossesByCharacter', 0) > 0)
    if not winners and not losers:
        return None
    mode = (winners or losers)[0]['mode']
    return {'mode': mode, 'winners': winners, 'losers': losers}


# ---------------------------------------------------------------------------
# replay filename -> {epoch, iso, game, players:[{name,char}]}
# ---------------------------------------------------------------------------
_REP = re.compile(r'^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d+)-(.+)-Game(\d+)\.rpl$')


def parse_replay_name(fname):
    m = _REP.match(fname)
    if not m:
        return None
    date, hh, mm, ss, ms, mid, game = m.groups()
    players = []
    for tok in mid.split(')-'):
        pm = re.match(r'^(.*)\(([^()]*)\)?$', tok)
        if pm:
            players.append({'name': pm.group(1), 'char': pm.group(2)})
    # Replay filenames are in LOCAL wall-clock time; mktime maps local -> UTC epoch.
    epoch = int(time.mktime((int(date[0:4]), int(date[5:7]), int(date[8:10]),
                             int(hh), int(mm), int(ss), 0, 0, -1)))
    return {'iso': _iso_of(epoch), 'epoch': epoch, 'game': int(game), 'players': players}


def _iso_of(epoch):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(epoch))


def _stamp_of(epoch):
    return time.strftime('%Y%m%d_%H%M%S', time.gmtime(epoch))


# ---------------------------------------------------------------------------
# Set state machine — groups per-game results into sets and writes the mod's
# files. GameN reset (a fresh Game1), idle timeout, or shutdown bound a set.
# ---------------------------------------------------------------------------
class _SetMachine:
    def __init__(self, out_dir, log, on_change=None):
        self.out = out_dir
        self.sets_dir = os.path.join(out_dir, 'sets')
        os.makedirs(self.sets_dir, exist_ok=True)
        self.log = log
        self.on_change = on_change   # called with snapshot() after any change
        self.set = None
        self.history = []            # finalized set summaries (for display)
        self.last_game_at = 0.0

    def _summ(self, s, complete):
        last = s['matches'][-1]
        players = sorted(
            [{'tag': p['name'], 'char': p['character'], 'wins': p['wins'], 'slot': p['slot']}
             for p in last['players']], key=lambda x: x['slot'])
        top = max((p['wins'] for p in players), default=0)
        unique = sum(1 for p in players if p['wins'] == top) == 1
        for p in players:
            p['won'] = (p['wins'] == top and top > 0 and unique)
        return {'startEpoch': s['startEpoch'], 'complete': complete,
                'games': len(s['matches']), 'players': players}

    def snapshot(self):
        live = self._summ(self.set, False) if self.set and self.set['matches'] else None
        return {'history': list(self.history), 'live': live}

    def _emit(self):
        if self.on_change:
            self.on_change(self.snapshot())

    def _write(self, name, obj):
        import json
        path = name if os.path.isabs(name) else os.path.join(self.out, name)
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(obj, f, indent=2)
        os.replace(tmp, path)

    def current(self, obj):
        self._write('current.json', obj)

    def live(self, obj):
        self._write('live.json', obj)

    def _start(self, at):
        self.set = {'id': _stamp_of(at), 'startEpoch': at, 'startIso': _iso_of(at),
                    'firstMatchStartIso': None, 'matches': [], 'winsByName': {}}

    def _players(self, result, replay):
        known = [dict(w, won=True) for w in result['winners']] + \
                [dict(l, won=False) for l in result['losers']]
        players = [{'name': k['tag'], 'character': k['char'], 'won': k['won'], 'stats': k['stats']}
                   for k in known]
        # ONLINE: only the local tag came from the save -> opponent from replay.
        if len(players) == 1 and replay and len(replay['players']) == 2:
            mine = players[0]
            opp = next((p for p in replay['players'] if p['char'] != mine['character']), None) or \
                next((p for p in replay['players'] if p['name'] != mine['name']), None)
            if opp:
                players.append({'name': opp['name'], 'character': opp['char'],
                                'won': not mine['won'], 'stats': {}})
        # slots from replay by character
        for pl in players:
            slot = None
            if replay:
                for idx, rp in enumerate(replay['players']):
                    if rp['char'] == pl['character']:
                        slot = idx; break
            pl['slot'] = slot
        for i, pl in enumerate(players):
            if pl['slot'] is None:
                pl['slot'] = i
        return players

    def record_game(self, result, replay, at):
        game_num = replay['game'] if replay else None
        end_epoch = replay['epoch'] if replay else at
        if game_num == 1 and self.set and self.set['matches']:
            self.finalize(True, at)
        if not self.set:
            self._start(end_epoch)

        players = self._players(result, replay)
        winner = next((p for p in players if p['won']), None)
        if winner:
            self.set['winsByName'][winner['name']] = self.set['winsByName'].get(winner['name'], 0) + 1

        match_players = []
        for p in players:
            row = {'slot': p['slot'], 'name': p['name'], 'character': p['character'],
                   'wins': self.set['winsByName'].get(p['name'], 0)}
            row.update(p['stats'])
            match_players.append(row)
        record = {'index': len(self.set['matches']) + 1, 'startTime': None, 'startEpoch': None,
                  'endTime': _iso_of(end_epoch), 'endEpoch': end_epoch, 'durationSeconds': None,
                  'playerCount': len(match_players), 'gameNumber': game_num, 'players': match_players}
        if not self.set['firstMatchStartIso']:
            self.set['firstMatchStartIso'] = record['endTime']
        self.set['matches'].append(record)
        self.last_game_at = time.time()

        standings = [{'slot': p['slot'], 'name': p['name'], 'character': p['character'], 'wins': p['wins']}
                     for p in match_players]
        self.live({'setId': self.set['id'], 'complete': False, 'winsRequired': None,
                   'matchCount': len(self.set['matches']), 'players': standings, 'matches': self.set['matches']})
        self.current({'state': 'set_open', 'epoch': end_epoch, 'setId': self.set['id'],
                      'matchCount': len(self.set['matches'])})
        self.log('game %s | %s -> %s wins [%s]' % (
            game_num, ' vs '.join('%s(%s)' % (p['name'], p['character']) for p in match_players),
            winner['name'] if winner else '?',
            ' '.join('%s %d' % (s['name'], s['wins']) for s in standings)))
        self._emit()

    def finalize(self, complete, at=None):
        if not self.set or not self.set['matches']:
            self.set = None
            return
        at = at or int(time.time())
        last = self.set['matches'][-1]
        standings = [{'slot': p['slot'], 'name': p['name'], 'character': p['character'], 'wins': p['wins']}
                     for p in last['players']]
        winner = None
        for p in standings:
            if winner is None or p['wins'] > winner['wins']:
                winner = p
        report = {'setId': self.set['id'], 'complete': complete,
                  'startTime': self.set['startIso'], 'startEpoch': self.set['startEpoch'],
                  'firstMatchStartTime': self.set['firstMatchStartIso'],
                  'endTime': _iso_of(at), 'endEpoch': at,
                  'durationSeconds': (at - self.set['startEpoch']) if self.set['startEpoch'] else None,
                  'winsRequired': None, 'matchCount': len(self.set['matches']),
                  'winnerSlot': winner['slot'] if winner else None,
                  'winnerName': winner['name'] if winner else None,
                  'winnerCharacter': winner['character'] if winner else None,
                  'players': standings, 'matches': self.set['matches'], 'source': 'stats-diff'}
        fname = 'set_%s%s.json' % (self.set['id'], '' if complete else '_interrupted')
        self._write(os.path.join(self.sets_dir, fname), report)
        self.log('finalized %s: %s wins %s (%d games, complete=%s)' % (
            fname, winner['name'] if winner else '?',
            '-'.join(str(s['wins']) for s in standings), len(self.set['matches']), complete))
        self.history.append(self._summ(self.set, complete))
        self.set = None
        self.current({'state': 'idle', 'epoch': at})
        self.live({'complete': True})
        self._emit()

    def idle_check(self, idle_s):
        if self.set and self.last_game_at and time.time() - self.last_game_at > idle_s:
            self.log('idle timeout - finalizing open set')
            self.finalize(True)


# ---------------------------------------------------------------------------
# Producer: wires the save/replays to the SetMachine. Call poll() each tick.
# ---------------------------------------------------------------------------
class StatsProducer:
    REPLAY_WINDOW_S = 20

    def __init__(self, save_path, replays_dir, out_dir, idle_s, log, on_change=None):
        self.save = save_path
        self.replays = replays_dir
        self.idle_s = idle_s
        self.log = log
        self.machine = _SetMachine(out_dir, log, on_change=on_change)
        self._mtime = None
        self._baseline = self._read()
        if self._baseline is not None:
            self.machine.current({'state': 'idle', 'epoch': int(time.time())})
            self.log('stats source armed | tags: %s' % ', '.join(tag_names(self._baseline)))
        else:
            self.log('WARNING: could not read save at %s' % self.save)

    def _read(self):
        try:
            return parse_stats(open(self.save, 'rb').read())
        except (OSError, ValueError, IndexError, struct.error):
            return None

    def _newest_replay_near(self, epoch):
        best = None
        try:
            names = os.listdir(self.replays)
        except OSError:
            return None
        for f in names:
            if not f.endswith('.rpl'):
                continue
            parsed = parse_replay_name(f)
            if not parsed or abs(parsed['epoch'] - epoch) > self.REPLAY_WINDOW_S:
                continue
            if best is None or parsed['epoch'] > best['epoch']:
                best = parsed
        return best

    def poll(self):
        self.machine.idle_check(self.idle_s)
        try:
            mtime = os.path.getmtime(self.save)
        except OSError:
            return
        if mtime == self._mtime:
            return
        self._mtime = mtime
        nxt = self._read()
        if nxt is None:
            return  # mid-write; retry next poll
        if self._baseline is None:
            self._baseline = nxt
            return
        result = to_game_result(diff(self._baseline, nxt))
        self._baseline = nxt
        if not result:
            return  # non-match write
        at = int(time.time())
        self.machine.record_game(result, self._newest_replay_near(at), at)

    def shutdown(self):
        self.machine.finalize(False)

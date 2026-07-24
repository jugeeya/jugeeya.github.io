"""Set/entrant matching for the LAN hub — a Python port of the logic in
broker/worker.js, so the operator can run an event with no Cloudflare at all.

Pure functions, stdlib only (the hub and the station sender both freeze to a
single .exe). Kept deliberately close to the Worker's behaviour so a set looks
the same whether it went through the broker or the hub.

One intentional difference: the Worker's winner match normalised names by
stripping whitespace only, while slot mapping stripped every non-alphanumeric.
Here both use the stricter `norm()`, so "JUGZ!" and "jugz" compare equal — that
only ever makes matching more forgiving, which is the direction we want.
"""
import re


def norm(s):
    """Lowercase, strip everything that isn't a letter or digit."""
    return re.sub(r'[^a-z0-9]', '', str(s if s is not None else '').lower())


def entrant_names(e):
    """Every name an entrant may appear under: start.gg tags can carry a
    sponsor prefix ("TEAM | Tag"), so match the full name and the bare tag."""
    full = str((e or {}).get('name') or '')
    if '|' in full:
        bare = full.split('|')[-1].strip()
        if bare:
            return [full, bare]
    return [full]


def build_tag_map(players_json):
    """players.json is written by hand as {"SAVE TAG": "startgg tag"}; lookups
    happen on normalized names, so key it that way once at load."""
    out = {}
    for k, v in (players_json or {}).items():
        nk = norm(k)
        if nk and v:
            out[nk] = v
    return out


def player_aliases(p, tag_map=None):
    """Every name a player might appear under on start.gg: an explicit
    start.gg name from the station (`sgg`), the players.json translation of
    their save tag, then the raw in-game name."""
    out = []
    if p and p.get('sgg'):
        out.append(p['sgg'])
    if tag_map and p:
        via = tag_map.get(norm(p.get('name')))
        if via:
            out.append(via)
    if p and p.get('name'):
        out.append(p['name'])
    return out


def match_winner(st, entrants, tag_map=None):
    """Best-effort winner match -> (candidate_entrant_id, confidence).

    In-game names rarely equal start.gg tags, so an unsure result is expected —
    the operator confirms before anything is finalized.
    """
    if not entrants or not st or not st.get('winnerName'):
        return (None, 'none')
    winner_player = None
    for p in (st.get('players') or []):
        if p.get('name') == st.get('winnerName'):
            winner_player = p
            break
    aliases = [norm(a) for a in player_aliases(
        winner_player or {'name': st.get('winnerName')}, tag_map)]
    aliases = [a for a in aliases if a]
    if not aliases:
        return (None, 'none')

    partial = None
    for e in entrants:
        for n in entrant_names(e):
            nn = norm(n)
            if not nn:
                continue
            if nn in aliases:
                return (e.get('id'), 'high')
            if partial is None and any(nn in a or a in nn for a in aliases):
                partial = e
    if partial is not None:
        return (partial.get('id'), 'low')
    return (None, 'none')


def derive_games(st):
    """Reduce the station's matches[] to a compact per-game record. Each match
    is one game; `wins` is cumulative, so the game's winner is whoever's win
    count ticked up that game."""
    matches = st.get('matches') if isinstance(st.get('matches'), list) else []
    prev_wins = {}
    games = []
    for i, m in enumerate(matches):
        mps = m.get('players') if isinstance(m.get('players'), list) else []
        winner_slot = None
        for p in mps:
            try:
                w = int(p.get('wins') or 0)
            except (TypeError, ValueError):
                w = 0
            if w > prev_wins.get(p.get('slot'), 0):
                winner_slot = p.get('slot')
            prev_wins[p.get('slot')] = w
        games.append({
            'gameNum': m.get('index') or (i + 1),
            'winnerSlot': winner_slot,
            'chars': [{'slot': p.get('slot'), 'character': p.get('character')} for p in mps],
        })
    return games


def summarize_set(st):
    """The compact record the hub stores and the console renders."""
    players = [{'slot': p.get('slot'), 'name': p.get('name'),
                'character': p.get('character'), 'wins': p.get('wins')}
               for p in (st.get('players') or [])] if isinstance(st.get('players'), list) else []
    match_count = st.get('matchCount')
    if match_count is None and isinstance(st.get('matches'), list):
        match_count = len(st['matches'])
    return {
        'setId': st.get('setId'),
        'complete': bool(st.get('complete')),
        'startEpoch': st.get('startEpoch'),
        'endEpoch': st.get('endEpoch'),
        'durationSeconds': st.get('durationSeconds'),
        'winsRequired': st.get('winsRequired'),
        'matchCount': match_count,
        'winnerSlot': st.get('winnerSlot'),
        'winnerName': st.get('winnerName'),
        'winnerCharacter': st.get('winnerCharacter'),
        'players': players,
        'games': derive_games(st),
    }


def map_slots_to_entrants(rec, winner_entrant_id=None, tag_map=None):
    """Map player slots -> start.gg entrant ids, or None if it can't be done.

    - Finalizing (winner_entrant_id given): anchor the winner's slot to the
      chosen entrant and the other slot to the other entrant — unambiguous.
    - Live (winner_entrant_id None): match by name, exact aliases first, then
      fuzzy, then pair leftovers by order. Never refuses to map: a swapped
      guess is one console click to fix, an absent live score isn't fixable.
    """
    entrants = rec.get('entrants') or []
    st = rec.get('set') or {}
    players = st.get('players') or []
    if len(entrants) != 2 or len(players) != 2:
        return None
    slots = [p.get('slot') for p in players]

    if winner_entrant_id is not None:
        winner_slot = st.get('winnerSlot')
        other = next((e for e in entrants
                      if str(e.get('id')) != str(winner_entrant_id)), None)
        other_slot = next((s for s in slots if s != winner_slot), None)
        if winner_slot is None or other is None or other_slot is None:
            return None
        return {winner_slot: str(winner_entrant_id), other_slot: str(other.get('id'))}

    mapping = {}
    used = set()
    for exact in (True, False):
        for p in players:
            if p.get('slot') in mapping:
                continue
            aliases = [a for a in (norm(x) for x in player_aliases(p, tag_map)) if a]
            if not aliases:
                continue
            hit = None
            for e in entrants:
                if e.get('id') in used:
                    continue
                for n in entrant_names(e):
                    nn = norm(n)
                    if not nn:
                        continue
                    ok = (nn in aliases) if exact else any(nn in a or a in nn for a in aliases)
                    if ok:
                        hit = e
                        break
                if hit is not None:
                    break
            if hit is not None:
                mapping[p.get('slot')] = str(hit.get('id'))
                used.add(hit.get('id'))

    open_slots = [s for s in slots if s not in mapping]
    open_entrants = [e for e in entrants if e.get('id') not in used]
    for i, s in enumerate(open_slots):
        if i < len(open_entrants):
            mapping[s] = str(open_entrants[i].get('id'))
    if len(mapping) != 2:
        return None
    # The operator said the station guessed identities backwards -> invert.
    if rec.get('swap'):
        a, b = slots
        mapping[a], mapping[b] = mapping[b], mapping[a]
    return mapping


def char_id_for(char_map, name):
    """Character id lookup: exact normalized name, else a unique prefix match —
    saves/replays store 3-letter codes ("Cla") while start.gg names are full
    ("Clairen"). Newer stations send full names; this keeps older ones working.
    """
    n = norm(name)
    if not n:
        return None
    if n in char_map:
        return char_map[n]
    hits = [k for k in char_map if k.startswith(n)]
    # "Ran" prefixes both Ranno and Random; the save spells Random out in full
    # (matched exactly above), so a code never means it.
    if len(hits) > 1:
        hits = [k for k in hits if k != 'random']
    return char_map[hits[0]] if len(hits) == 1 else None


def game_data_from_games(games, slot_to_entrant, char_map):
    """Per-game start.gg gameData: [{gameNum, winnerId?, selections?}]."""
    out = []
    for g in (games or []):
        winner_id = slot_to_entrant.get(g.get('winnerSlot')) if g.get('winnerSlot') is not None else None
        selections = []
        for c in (g.get('chars') or []):
            eid = slot_to_entrant.get(c.get('slot'))
            cid = char_id_for(char_map, c.get('character'))
            if eid and cid is not None:
                selections.append({'entrantId': eid, 'characterId': cid})
        game = {'gameNum': g.get('gameNum')}
        if winner_id:
            game['winnerId'] = winner_id
        if selections:
            game['selections'] = selections
        out.append(game)
    return out

"""LAN hub — the operator's local replacement for the Cloudflare broker.

At an event every machine is on the same network, so there is no reason to send
per-game traffic to the cloud: the operator runs this, the stations POST to it,
and it is the only thing that talks to start.gg. Cloudflare is then not in the
loop at all (no KV reads, writes or list ops).

It deliberately speaks the SAME /matchlogger/* HTTP API as broker/worker.js, so
a station switches over by pointing its broker URL at the operator's LAN
address — no station code changes:

    POST /matchlogger/current   {slug, station, key, current}
    POST /matchlogger/live      {slug, station, key, set}    -> live start.gg score
    POST /matchlogger/ingest    {slug, station, key, set}
    GET  /matchlogger/event?slug=...
    GET  /matchlogger/version?slug=...
    POST /matchlogger/report    {slug, station, setId, winnerEntrantId, passcode}
    POST /matchlogger/swap      {slug, station, setId, passcode}
    POST /matchlogger/delete    {slug, station, setId, passcode}

Reporting a winner (which advances the bracket) is never automatic — only the
operator's explicit action calls it, exactly as with the broker. Per-game live
scores DO go out automatically, without setting a winner.

Stdlib only, so it freezes into the same .exe as the station app.
"""
import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import matching
from rivals_stats import is_reportable, mode_label
from startgg import Startgg, StartggError

DEFAULT_PORT = 8787


def lan_ip():
    """This machine's LAN address — what stations should point at."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))   # no packets sent; just picks the iface
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


class Hub:
    """Event state + the start.gg side effects. Transport-agnostic: the HTTP
    handler and the operator UI both call these methods."""

    def __init__(self, key=None, token=None, tag_map=None, state_path=None,
                 log=None, on_change=None, learned_path=None):
        self.key = (key or '').strip() or None
        self.tag_map = dict(tag_map or {})
        # Corrections the operator has made (save tag -> start.gg tag), kept
        # apart from the hand-written players.json so that file is never
        # rewritten. Merged over it, so a manual entry can be corrected once.
        self.learned_path = learned_path
        self.learned = {}
        if learned_path and os.path.exists(learned_path):
            try:
                with open(learned_path, 'r', encoding='utf-8') as f:
                    self.learned = json.load(f) or {}
                self.tag_map.update(matching.build_tag_map(self.learned))
            except (OSError, ValueError):
                self.learned = {}
        self.log = log or (lambda m: None)
        self.on_change = on_change
        self.startgg = Startgg(token, log=self.log)
        self.state_path = state_path
        self._lock = threading.RLock()
        self.version = 0
        # {slug: {station: {...}}} and {slug: {"station:setId": record}}
        self.stations = {}
        self.sets = {}
        self._load()

    # -- persistence --------------------------------------------------------
    def _load(self):
        if not self.state_path or not os.path.exists(self.state_path):
            return
        try:
            with open(self.state_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            self.stations = data.get('stations') or {}
            self.sets = data.get('sets') or {}
            self.version = int(data.get('version') or 0)
            self.log('hub state restored (%d set(s))'
                     % sum(len(v) for v in self.sets.values()))
        except (OSError, ValueError) as e:
            self.log('could not read hub state: %s' % e)

    def _save(self):
        if not self.state_path:
            return
        try:
            tmp = self.state_path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump({'version': self.version, 'stations': self.stations,
                           'sets': self.sets}, f, indent=2)
            os.replace(tmp, self.state_path)
        except OSError as e:
            self.log('could not write hub state: %s' % e)

    def _touch(self):
        self.version += 1
        self._save()
        if self.on_change:
            try:
                self.on_change(self.snapshot())
            except Exception:
                pass

    # -- helpers ------------------------------------------------------------
    def check_key(self, supplied):
        """Stations/console must present the shared key when one is set. On a
        LAN this is mostly about catching misconfiguration, but it also stops a
        stray machine polluting the event."""
        return self.key is None or str(supplied or '') == self.key

    @staticmethod
    def _sid(station, set_id):
        return '%s:%s' % (station, set_id)

    def _set_bucket(self, slug):
        return self.sets.setdefault(slug, {})

    def _bind_station_set(self, slug, station):
        """Look up which start.gg set is at this station (entrants, round)."""
        if not self.startgg.enabled:
            return None
        try:
            return self.startgg.station_set(slug, station)
        except StartggError as e:
            self.log('station lookup failed: %s' % e)
            return None

    # -- station-facing -----------------------------------------------------
    def handle_current(self, slug, station, current):
        current = current if isinstance(current, dict) else {}
        with self._lock:
            rec = {'station': station, 'current': current, 'updatedAt': int(time.time())}
            # A set just started here -> pre-bind the two entrants now, so the
            # eventual live/ingest can name a winner with far less ambiguity.
            if current.get('state') == 'set_start':
                sg = self._bind_station_set(slug, station)
                if sg:
                    rec['startgg'] = sg
            else:
                prev = (self.stations.get(slug) or {}).get(str(station)) or {}
                if prev.get('startgg'):
                    rec['startgg'] = prev['startgg']
            self.stations.setdefault(slug, {})[str(station)] = rec
            self._touch()
        return {'ok': True, 'startgg': rec.get('startgg')}

    def _record_for(self, slug, station, st, status):
        """Build/refresh the stored record for a set coming off a station."""
        sg = None
        prev_station = (self.stations.get(slug) or {}).get(str(station)) or {}
        if prev_station.get('startgg'):
            sg = prev_station['startgg']
        if not sg:
            sg = self._bind_station_set(slug, station)
        summary = matching.summarize_set(st)
        summary['mode'] = st.get('mode')
        key = self._sid(station, st.get('setId'))
        prev = self._set_bucket(slug).get(key) or {}
        cand, conf = matching.match_winner(summary, (sg or {}).get('entrants'), self.tag_map)

        # Two independent reasons a set must stay off the bracket.
        reason = None
        if not is_reportable(st.get('mode')):
            reason = '%s game' % (mode_label(st.get('mode')) or 'non-local')
        elif sg and not matching.set_started(sg):
            # Called to this station but the TO hasn't pressed Start Match, so
            # anything played here is still a warmup.
            reason = 'match not started on start.gg'
        elif not sg:
            reason = 'no start.gg set at this station'
        rec = {
            'id': st.get('setId'), 'station': station,
            'ingestedAt': int(time.time()), 'set': summary,
            'matchedStartggSetId': (sg or {}).get('setId'),
            'fullRoundText': (sg or {}).get('fullRoundText'),
            'entrants': (sg or {}).get('entrants'),
            'candidateWinnerEntrantId': cand, 'confidence': conf,
            'status': status if not prev.get('status') == 'reported' else 'reported',
            'swap': prev.get('swap', False),
            'mode': st.get('mode'),
            'startggState': (sg or {}).get('state'),
            'reportable': reason is None,
            'notReportableReason': reason,
        }
        # Not a tournament game, or the match isn't underway yet: keep the
        # record (the operator still wants to see it) but don't let it borrow
        # the station's bracket set, or the console would offer to report it.
        if reason:
            rec['matchedStartggSetId'] = None
            rec['candidateWinnerEntrantId'] = None
            rec['confidence'] = 'none'
            rec['status'] = (mode_label(st.get('mode'))
                             or ('waiting for start' if sg else 'recorded'))
        # Preserve anything the operator already decided.
        for k in ('reportedAt', 'reportedWinnerEntrantId', 'reportedGames', 'reportedBy'):
            if k in prev:
                rec[k] = prev[k]
        if prev.get('swap') and cand and rec.get('entrants') and len(rec['entrants']) == 2:
            other = next((e for e in rec['entrants'] if str(e.get('id')) != str(cand)), None)
            if other:
                rec['candidateWinnerEntrantId'] = other.get('id')
        return key, rec

    def handle_live(self, slug, station, st):
        """A running set: store it and push the games-so-far to start.gg
        WITHOUT a winner, so the bracket never advances."""
        if not isinstance(st, dict):
            return {'error': 'Missing set.'}, 400
        with self._lock:
            key, rec = self._record_for(slug, station, st, 'live')
            # Don't clobber the mode label _record_for set for online/ranked.
            if rec.get('status') != 'reported' and rec.get('reportable', True):
                rec['status'] = 'live'
            self._set_bucket(slug)[key] = rec
            self._touch()

        live, games, reason = False, 0, None
        if not rec.get('reportable', True):
            reason = '%s — logged, not reported' % (rec.get('notReportableReason') or 'not reportable')
        elif not self.startgg.enabled:
            reason = 'no start.gg token'
        elif not rec.get('matchedStartggSetId'):
            reason = 'no matched start.gg set'
        else:
            slot_map = matching.map_slots_to_entrants(rec, None, self.tag_map)
            if not slot_map:
                reason = 'could not map players to entrants'
            else:
                cmap = self.startgg.character_map(slug)
                gd = [g for g in matching.game_data_from_games(
                    rec['set'].get('games') or [], slot_map, cmap) if g.get('winnerId')]
                if not gd:
                    reason = 'no completed games yet'
                else:
                    try:
                        self.startgg.update_live(rec['matchedStartggSetId'], gd)
                        live, games = True, len(gd)
                    except StartggError as e:
                        reason = 'start.gg update failed: %s' % e
        if reason:
            self.log('live (station %s): %s' % (station, reason))
        else:
            self.log('live (station %s): pushed %d game(s) to start.gg' % (station, games))
        return {'ok': True, 'live': live, 'games': games, 'reason': reason}

    def handle_ingest(self, slug, station, st):
        """A finished set. Stored and matched; never written to the bracket —
        finalizing is the operator's call."""
        if not isinstance(st, dict):
            return {'error': 'Missing set.'}, 400
        with self._lock:
            key, rec = self._record_for(slug, station, st, 'recorded')
            if rec.get('status') != 'reported' and rec.get('reportable', True):
                rec['status'] = 'matched' if rec.get('matchedStartggSetId') else 'recorded'
            self._set_bucket(slug)[key] = rec
            self._touch()
        self.log('ingested set %s from station %s' % (st.get('setId'), station))
        return {'ok': True, 'record': rec}

    # -- operator-facing ----------------------------------------------------
    def event_view(self, slug):
        with self._lock:
            sets = sorted((self._set_bucket(slug)).values(),
                          key=lambda r: r.get('ingestedAt') or 0)
            return {'slug': slug, 'stations': dict(self.stations.get(slug) or {}),
                    'sets': [json.loads(json.dumps(s)) for s in sets]}

    def snapshot(self):
        """Everything the operator UI renders, newest set first."""
        with self._lock:
            out = []
            for slug, bucket in self.sets.items():
                for rec in bucket.values():
                    out.append(rec)
            out.sort(key=lambda r: r.get('ingestedAt') or 0, reverse=True)
            return {'version': self.version, 'sets': out,
                    'stations': dict(self.stations)}

    def get_set(self, slug, station, set_id):
        with self._lock:
            return self._set_bucket(slug).get(self._sid(station, set_id))

    def rebind(self, slug, station, set_id):
        """Re-ask start.gg what's at this station and re-evaluate the record.

        A set finished before the TO pressed Start Match is correctly refused at
        the time; once they do start it, nothing else would revisit that record
        (finished sets get no further station updates), so the operator's next
        Report re-checks instead of being stuck.
        """
        rec = self.get_set(slug, station, set_id)
        if not rec or not is_reportable((rec.get('set') or {}).get('mode')):
            return rec
        try:
            sg = self.startgg.station_set(slug, station, max_age=0)
        except StartggError as e:
            self.log('re-check failed: %s' % e)
            return rec
        if not matching.set_started(sg):
            return rec
        with self._lock:
            # Refresh the station's cached binding too, so later updates agree.
            stn = self.stations.setdefault(slug, {}).setdefault(str(station), {})
            stn['startgg'] = sg
            rec['matchedStartggSetId'] = sg.get('setId')
            rec['fullRoundText'] = sg.get('fullRoundText')
            rec['entrants'] = sg.get('entrants')
            rec['startggState'] = sg.get('state')
            rec['reportable'] = True
            rec['notReportableReason'] = None
            if rec.get('status') not in ('reported',):
                rec['status'] = 'matched'
            cand, conf = matching.match_winner(rec.get('set') or {},
                                               sg.get('entrants'), self.tag_map)
            rec['candidateWinnerEntrantId'] = cand
            rec['confidence'] = conf
            self._touch()
        self.log('set %s re-bound: match is now started on start.gg' % set_id)
        return rec

    def do_report(self, slug, station, set_id, winner_entrant_id):
        """Advance the bracket. Operator action only."""
        rec = self.get_set(slug, station, set_id)
        if not rec:
            return {'error': 'Set not found.'}, 404
        # The TO may have pressed Start Match after this set finished.
        if not rec.get('reportable', True):
            rec = self.rebind(slug, station, set_id) or rec
        if not rec.get('reportable', True):
            return {'error': 'Not reportable: %s.'
                             % (rec.get('notReportableReason') or 'not a tournament set')}, 409
        if not rec.get('matchedStartggSetId'):
            return {'error': 'This set is not matched to a start.gg set.'}, 409
        if not self.startgg.enabled:
            return {'error': 'No start.gg token configured on the hub.'}, 501
        winner_entrant_id = str(winner_entrant_id or '')
        if not winner_entrant_id:
            return {'error': 'Missing winnerEntrantId.'}, 400
        ents = rec.get('entrants') or []
        if ents and not any(str(e.get('id')) == winner_entrant_id for e in ents):
            return {'error': "winnerEntrantId is not one of this set's entrants."}, 400

        game_data = None
        try:
            slot_map = matching.map_slots_to_entrants(rec, winner_entrant_id, self.tag_map)
            if slot_map:
                cmap = self.startgg.character_map(slug)
                gd = matching.game_data_from_games(
                    (rec.get('set') or {}).get('games') or [], slot_map, cmap)
                if gd and all(g.get('winnerId') for g in gd):
                    game_data = gd
        except Exception:
            game_data = None       # fall back to winner-only
        try:
            self.startgg.report_set(rec['matchedStartggSetId'], winner_entrant_id, game_data)
        except StartggError as e:
            return {'error': 'start.gg report failed: %s' % e}, 502
        with self._lock:
            rec['status'] = 'reported'
            rec['reportedAt'] = int(time.time())
            rec['reportedWinnerEntrantId'] = winner_entrant_id
            rec['reportedGames'] = len(game_data or [])
            rec['reportedBy'] = 'operator'
            self._touch()
        self.log('reported set %s (station %s) to start.gg' % (set_id, station))
        return {'ok': True, 'record': rec, 'gamesReported': rec['reportedGames']}

    def _learn_aliases(self, rec):
        """Remember which save tag belongs to which start.gg entrant.

        The station can only ever guess: in-game tags don't have to match
        start.gg tags. Once the operator corrects a set, that pairing is a fact
        — record it so the next set between the same people maps right without
        another correction. Kept in its own file so a hand-written players.json
        is never rewritten.
        """
        smap = matching.map_slots_to_entrants(rec, None, self.tag_map)
        if not smap:
            return
        by_id = {str(e.get('id')): e.get('name') for e in (rec.get('entrants') or [])}
        learned = False
        for p in ((rec.get('set') or {}).get('players') or []):
            gg = by_id.get(str(smap.get(p.get('slot'))))
            key = matching.norm(p.get('name'))
            if gg and key and self.tag_map.get(key) != gg:
                self.tag_map[key] = gg
                self.learned[p.get('name')] = gg
                learned = True
        if learned and self.learned_path:
            try:
                tmp = self.learned_path + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(self.learned, f, indent=2)
                os.replace(tmp, self.learned_path)
            except OSError as e:
                self.log('could not save learned tags: %s' % e)
        if learned:
            self.log('learned tag mapping: %s' % ', '.join(
                '%s -> %s' % kv for kv in self.learned.items()))

    def do_swap(self, slug, station, set_id):
        """Flip which in-game player maps to which start.gg entrant, re-push the
        corrected live score, and remember the pairing for future sets."""
        rec = self.get_set(slug, station, set_id)
        if not rec:
            return {'error': 'Set not found.'}, 404
        with self._lock:
            rec['swap'] = not rec.get('swap')
            ents = rec.get('entrants') or []
            if rec.get('candidateWinnerEntrantId') and len(ents) == 2:
                other = next((e for e in ents
                              if str(e.get('id')) != str(rec['candidateWinnerEntrantId'])), None)
                if other:
                    rec['candidateWinnerEntrantId'] = other.get('id')
            self._learn_aliases(rec)
            self._touch()
        repushed = False
        if self.startgg.enabled and rec.get('matchedStartggSetId') and rec.get('reportable', True):
            try:
                slot_map = matching.map_slots_to_entrants(rec, None, self.tag_map)
                if slot_map:
                    cmap = self.startgg.character_map(slug)
                    gd = [g for g in matching.game_data_from_games(
                        (rec.get('set') or {}).get('games') or [], slot_map, cmap)
                        if g.get('winnerId')]
                    if gd:
                        self.startgg.update_live(rec['matchedStartggSetId'], gd)
                        repushed = True
            except StartggError as e:
                self.log('swap re-push failed: %s' % e)
        return {'ok': True, 'swap': rec['swap'], 'repushed': repushed, 'record': rec}

    def do_delete(self, slug, station, set_id):
        """Drop a set from the operator's view. start.gg is never touched."""
        with self._lock:
            removed = self._set_bucket(slug).pop(self._sid(station, set_id), None)
            if removed is None:
                return {'error': 'Set not found.'}, 404
            self._touch()
        self.log('deleted set %s (station %s)' % (set_id, station))
        return {'ok': True}


# ---------------------------------------------------------------------------
# HTTP front end
# ---------------------------------------------------------------------------
class _Handler(BaseHTTPRequestHandler):
    server_version = 'RivalsHub/1.0'
    hub = None            # injected by HubServer

    def log_message(self, fmt, *args):        # quiet: the app has its own log
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        # The operator console may be served from anywhere on the LAN.
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send({}, 204)

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        if not u.path.startswith('/matchlogger/'):
            return self._send({'error': 'Not found.'}, 404)
        op = u.path[len('/matchlogger/'):]
        slug = (parse_qs(u.query).get('slug') or [''])[0]
        if op == 'version':
            return self._send({'v': self.hub.version})
        if op == 'event':
            if not slug:
                return self._send({'error': 'Expected an event slug.'}, 400)
            return self._send(self.hub.event_view(slug))
        if op == 'health':
            return self._send({'ok': True, 'startgg': self.hub.startgg.enabled})
        return self._send({'error': 'Unknown operation.'}, 404)

    def do_POST(self):
        if not self.path.startswith('/matchlogger/'):
            return self._send({'error': 'Not found.'}, 404)
        op = self.path[len('/matchlogger/'):].split('?')[0]
        try:
            n = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(n).decode('utf-8')) if n else {}
        except (ValueError, OSError):
            return self._send({'error': 'Expected a JSON body.'}, 400)
        if not isinstance(body, dict):
            return self._send({'error': 'Expected a JSON object.'}, 400)

        slug = str(body.get('slug') or '').strip()
        if not slug:
            return self._send({'error': 'Bad or missing event slug.'}, 400)
        # One shared key for stations and operator actions, like the broker.
        supplied = body.get('key') if op in ('current', 'live', 'ingest') else body.get('passcode')
        if not self.hub.check_key(supplied):
            return self._send({'error': 'Bad key.'}, 401)

        station = body.get('station')
        try:
            station = int(station)
        except (TypeError, ValueError):
            if op in ('current', 'live', 'ingest', 'report', 'swap', 'delete'):
                return self._send({'error': 'Bad or missing station.'}, 400)

        def out(res):
            if isinstance(res, tuple):
                return self._send(res[0], res[1])
            return self._send(res)

        try:
            if op == 'current':
                return out(self.hub.handle_current(slug, station, body.get('current')))
            if op == 'live':
                return out(self.hub.handle_live(slug, station, body.get('set')))
            if op == 'ingest':
                return out(self.hub.handle_ingest(slug, station, body.get('set')))
            if op == 'report':
                return out(self.hub.do_report(slug, station, body.get('setId'),
                                              body.get('winnerEntrantId')))
            if op == 'swap':
                return out(self.hub.do_swap(slug, station, body.get('setId')))
            if op == 'delete':
                return out(self.hub.do_delete(slug, station, body.get('setId')))
        except Exception as e:                       # never kill the server
            self.hub.log('hub error on /%s: %s' % (op, e))
            return self._send({'error': 'Hub error: %s' % e}, 500)
        return self._send({'error': 'Unknown operation.'}, 404)


class HubServer:
    """Runs a Hub over HTTP on the LAN, in a background thread."""

    def __init__(self, hub, port=DEFAULT_PORT, bind='0.0.0.0'):
        self.hub = hub
        self.port = int(port)
        self.bind = bind
        self._srv = None
        self._thread = None

    @property
    def running(self):
        return self._srv is not None

    def url(self):
        return 'http://%s:%d' % (lan_ip(), self.port)

    def start(self):
        if self._srv:
            return self.url()
        handler = type('_BoundHandler', (_Handler,), {'hub': self.hub})
        self._srv = ThreadingHTTPServer((self.bind, self.port), handler)
        self._srv.daemon_threads = True
        self._thread = threading.Thread(target=self._srv.serve_forever, daemon=True)
        self._thread.start()
        self.hub.log('hub listening on %s (stations point here)' % self.url())
        return self.url()

    def stop(self):
        if self._srv:
            try:
                self._srv.shutdown()
                self._srv.server_close()
            except Exception:
                pass
            self._srv = None

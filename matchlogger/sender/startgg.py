"""start.gg client for the LAN hub (stdlib only).

Only the operator runs this: the API token lives on exactly one machine and
every start.gg call for the event funnels through one rate-limited client.

The broker had to read through start.gg's unauthenticated website API (it had
no token for reads); here we hold a token, so reads and writes both go to the
official endpoint.

Write semantics, unchanged from the broker:
  * update_live()  -> markSetInProgress + updateBracketSet: records the
                      games-so-far WITHOUT a winner, so the bracket does not
                      advance. Safe to call automatically after every game.
  * report_set()   -> reportBracketSet with a winner: advances the bracket.
                      Only ever called from an explicit operator action.
"""
import json
import threading
import time
import urllib.error
import urllib.request

API_URL = 'https://api.start.gg/gql/alpha'
# start.gg allows ~80 requests/60s per token; stay well under it.
MIN_INTERVAL_S = 0.8
STATION_CACHE_S = 15      # station lookups repeat on every heartbeat
CHARACTER_CACHE_S = 604800


class StartggError(Exception):
    pass


class Startgg:
    def __init__(self, token, log=None):
        self.token = (token or '').strip()
        self.log = log or (lambda m: None)
        self._lock = threading.Lock()
        self._last_call = 0.0
        self._chars = {}          # slug -> (fetched_at, {name: id})
        self._stations = {}       # (slug, station) -> (fetched_at, result)

    @property
    def enabled(self):
        return bool(self.token)

    # -- transport ----------------------------------------------------------
    def _gql(self, query, variables):
        if not self.token:
            raise StartggError('no start.gg token configured')
        with self._lock:                      # serialize + throttle
            gap = time.time() - self._last_call
            if gap < MIN_INTERVAL_S:
                time.sleep(MIN_INTERVAL_S - gap)
            self._last_call = time.time()
        body = json.dumps({'query': query, 'variables': variables}).encode('utf-8')
        req = urllib.request.Request(
            API_URL, data=body, method='POST',
            headers={'Content-Type': 'application/json',
                     'Authorization': 'Bearer ' + self.token,
                     'User-Agent': 'rivals-station-hub/1.0'})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                out = json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            raise StartggError('start.gg HTTP %s' % e.code)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise StartggError('start.gg unreachable: %s' % e)
        except ValueError:
            raise StartggError('start.gg returned invalid JSON')
        if out.get('errors'):
            raise StartggError(str(out['errors'][0].get('message') or 'GraphQL error'))
        return out.get('data') or {}

    # -- reads --------------------------------------------------------------
    def station_set(self, slug, station, max_age=STATION_CACHE_S):
        """The not-yet-completed set currently at a station, with entrants.

        start.gg's filters don't reliably support station number, so pull the
        event's active sets and match locally (same approach as the broker).
        """
        key = (slug, int(station))
        hit = self._stations.get(key)
        if hit and time.time() - hit[0] < max_age:
            return hit[1]
        data = self._gql(
            '''query($slug:String!){ event(slug:$slug){
                 sets(page:1, perPage:60, sortType:STANDARD, filters:{ state:[1,2,6] }){
                   nodes{ id state fullRoundText station{ number }
                     slots{ entrant{ id name } } } } } }''',
            {'slug': slug})
        nodes = (((data.get('event') or {}).get('sets') or {}).get('nodes')) or []
        found = None
        for n in nodes:
            st = (n.get('station') or {}).get('number')
            if st is not None and int(st) == int(station):
                found = n
                break
        result = None
        if found:
            entrants = []
            for s in (found.get('slots') or []):
                e = s.get('entrant')
                if e:
                    entrants.append({'id': e.get('id'), 'name': e.get('name') or ''})
            result = {'found': True, 'setId': found.get('id'), 'state': found.get('state'),
                      'fullRoundText': found.get('fullRoundText') or '', 'entrants': entrants}
        self._stations[key] = (time.time(), result)
        return result

    def character_map(self, slug):
        """Character name -> start.gg id for the event's game (cached)."""
        hit = self._chars.get(slug)
        if hit and time.time() - hit[0] < CHARACTER_CACHE_S:
            return hit[1]
        try:
            data = self._gql(
                'query($slug:String!){ event(slug:$slug){ videogame{ id characters{ id name } } } }',
                {'slug': slug})
        except StartggError as e:
            self.log('character map unavailable: %s' % e)
            return (hit[1] if hit else {})
        from matching import norm
        chars = (((data.get('event') or {}).get('videogame') or {}).get('characters')) or []
        cmap = {}
        for c in chars:
            if c and c.get('name') is not None:
                cmap[norm(c['name'])] = c.get('id')
        if cmap:
            self._chars[slug] = (time.time(), cmap)
        return cmap

    # -- writes -------------------------------------------------------------
    def update_live(self, set_id, game_data):
        """Non-advancing: record games so far. No winner is set, so the bracket
        never advances — finalizing stays an explicit operator action."""
        # Only needed the first time; later games error "Set is already
        # started". Swallow that so it can't abort the score update (the bug
        # that froze live scores at game 1).
        try:
            self._gql('mutation($id:ID!){ markSetInProgress(setId:$id){ id state } }',
                      {'id': set_id})
        except StartggError as e:
            if 'already started' not in str(e).lower():
                raise
        self._gql(
            '''mutation($id:ID!,$g:[BracketSetGameDataInput]){
                 updateBracketSet(setId:$id, gameData:$g){ id state } }''',
            {'id': set_id, 'g': game_data})

    def report_set(self, set_id, winner_entrant_id, game_data=None):
        """Advancing: set the winner and finalize. Operator action only."""
        return self._gql(
            '''mutation($setId:ID!,$winnerId:ID!,$gameData:[BracketSetGameDataInput]){
                 reportBracketSet(setId:$setId, winnerId:$winnerId, gameData:$gameData){ id state } }''',
            {'setId': set_id, 'winnerId': winner_entrant_id, 'gameData': game_data})

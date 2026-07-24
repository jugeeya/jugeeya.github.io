"""End-to-end tests for the LAN hub.

Runs a real HubServer on localhost and drives it with the real station_sender
Sender — the same code path a station PC uses — so the "point the station at
the operator instead of the broker" claim is actually exercised. start.gg is
stubbed (no token, or a fake client) so nothing touches a live bracket.

Run: python test_hub.py
"""
import json
import os
import shutil
import sys
import tempfile
import time

import hub as hubmod
import matching
import station_sender as ss

fails = 0
SLUG = 'tournament/the-hangout-4-1/event/rivals-of-aether-ii-singles'
KEY = 'thehangout2026!'


def ok(cond, msg):
    global fails
    print(('PASS' if cond else 'FAIL') + '  ' + msg)
    if not cond:
        fails += 1


REAL_SET = {
    'setId': '20260724_075508', 'complete': True, 'matchCount': 2,
    'winnerSlot': 0, 'winnerName': 'JUGZ!', 'winnerCharacter': 'Orc',
    'startEpoch': 1784879708, 'endEpoch': 1784879970,
    'players': [{'slot': 0, 'name': 'JUGZ!', 'character': 'Orc', 'wins': 2},
                {'slot': 1, 'name': 'KIM', 'character': 'Gal', 'wins': 0}],
    'matches': [
        {'index': 1, 'players': [{'slot': 0, 'name': 'JUGZ!', 'character': 'Orc', 'wins': 1},
                                 {'slot': 1, 'name': 'KIM', 'character': 'Gal', 'wins': 0}]},
        {'index': 2, 'players': [{'slot': 0, 'name': 'JUGZ!', 'character': 'Orc', 'wins': 2},
                                 {'slot': 1, 'name': 'KIM', 'character': 'Gal', 'wins': 0}]},
    ],
}
ENTRANTS = [{'id': 24186345, 'name': 'jugeeya'}, {'id': 24186347, 'name': 'Kimchi'}]


class FakeStartgg:
    """Stands in for the real client: records what would have been sent."""
    def __init__(self, enabled=True):
        self.enabled = enabled
        self.live_pushes = []
        self.reports = []

    def station_set(self, slug, station, max_age=None):
        return {'found': True, 'setId': 105639152, 'state': 2,
                'fullRoundText': 'Winners Round 1', 'entrants': ENTRANTS}

    def character_map(self, slug):
        return {'orcane': 41, 'galvan': 42, 'random': 99}

    def update_live(self, set_id, game_data):
        self.live_pushes.append((set_id, game_data))

    def report_set(self, set_id, winner_id, game_data=None):
        self.reports.append((set_id, winner_id, game_data))
        return {}


workdir = tempfile.mkdtemp(prefix='hubtest_')
logs = []
tag_map = matching.build_tag_map({'JUGZ!': 'jugeeya', 'KIM': 'Kimchi'})
h = hubmod.Hub(key=KEY, token=None, tag_map=tag_map,
               state_path=os.path.join(workdir, 'hub-state.json'),
               log=logs.append)
fake = FakeStartgg()
h.startgg = fake

server = hubmod.HubServer(h, port=8799, bind='127.0.0.1')
server.start()
BROKER = 'http://127.0.0.1:8799'
time.sleep(0.3)

# ---- the station sender, unmodified, pointed at the hub --------------------
station_dir = os.path.join(workdir, 'station')
os.makedirs(os.path.join(station_dir, 'sets'), exist_ok=True)
sender = ss.Sender(broker=BROKER, slug=SLUG, station=1, out_dir=station_dir,
                   state_path=os.path.join(station_dir, 'state.json'),
                   dry_run=False, key=KEY)

# heartbeat: a set is starting at station 1
with open(os.path.join(station_dir, 'current.json'), 'w', encoding='utf-8') as f:
    json.dump({'state': 'set_start', 'epoch': 1784879708, 'setId': REAL_SET['setId']}, f)
sender.tick()
ok((h.stations.get(SLUG) or {}).get('1') is not None, "station heartbeat reached the hub")
ok(((h.stations[SLUG]['1'].get('startgg') or {}).get('setId')) == 105639152,
   "set_start pre-bound the start.gg set + entrants")

# live: a running set (game 1 then both games)
live_body = dict(REAL_SET, complete=False, matchCount=2)
with open(os.path.join(station_dir, 'live.json'), 'w', encoding='utf-8') as f:
    json.dump(live_body, f)
sender.tick()
ok(len(fake.live_pushes) == 1, "live update pushed to start.gg")
pushed_id, pushed_games = fake.live_pushes[-1]
ok(pushed_id == 105639152, "pushed against the matched start.gg set")
ok(len(pushed_games) == 2 and all(g.get('winnerId') for g in pushed_games),
   "BOTH games pushed with a winnerId (2-0 reports as 2-0)")
ok(all('selections' in g for g in pushed_games), "character selections included")
ok(len(fake.reports) == 0,
   "live push never advanced the bracket (no reportBracketSet call)")

# ingest: the finished set
with open(os.path.join(station_dir, 'sets', 'set_x.json'), 'w', encoding='utf-8') as f:
    json.dump(REAL_SET, f)
sender.tick()
view = h.event_view(SLUG)
ok(len(view['sets']) == 1, "hub holds exactly one set record")
rec = view['sets'][0]
ok(rec['status'] in ('matched', 'live'), "set is matched to start.gg  [%s]" % rec['status'])
ok(str(rec['candidateWinnerEntrantId']) == '24186345',
   "candidate winner resolved to jugeeya via players.json")
ok(rec['confidence'] == 'high', "confidence high")
ok(len(fake.reports) == 0, "ingest did NOT report to start.gg (finalizing stays manual)")

# ---- version counter -------------------------------------------------------
v1 = h.version
h.handle_current(SLUG, 1, {'state': 'idle'})
ok(h.version > v1, "version counter bumps on change (cheap console polling)")

# ---- operator actions ------------------------------------------------------
res = h.do_swap(SLUG, 1, REAL_SET['setId'])
ok(res.get('swap') is True, "swap toggles the mapping")
ok(str(h.get_set(SLUG, 1, REAL_SET['setId'])['candidateWinnerEntrantId']) == '24186347',
   "swap flips the candidate winner to Kimchi")
ok(res.get('repushed') is True, "swap immediately re-pushed the corrected live score")
h.do_swap(SLUG, 1, REAL_SET['setId'])  # back

rep = h.do_report(SLUG, 1, REAL_SET['setId'], 24186345)
ok(rep.get('ok') is True, "operator report succeeded")
ok(len(fake.reports) == 1, "reportBracketSet called exactly once")
ok(fake.reports[0][1] == '24186345', "reported winner is jugeeya")
ok(len(fake.reports[0][2] or []) == 2, "final report carried both games")
ok(h.get_set(SLUG, 1, REAL_SET['setId'])['status'] == 'reported', "status -> reported")

# ---- report with no token degrades honestly --------------------------------
h2 = hubmod.Hub(key=None, token=None, tag_map=tag_map, state_path=None, log=logs.append)
h2.handle_ingest(SLUG, 2, REAL_SET)
res2 = h2.do_report(SLUG, 2, REAL_SET['setId'], 1)
ok(isinstance(res2, tuple) and res2[1] in (409, 501),
   "no token / unmatched -> honest error, not a silent success  [%s]" % (res2[1],))

# ---- delete ----------------------------------------------------------------
ok(h.do_delete(SLUG, 1, REAL_SET['setId']).get('ok') is True, "delete removes the set")
ok(len(h.event_view(SLUG)['sets']) == 0, "set is gone from the view")
ok(len(fake.reports) == 1, "delete never touched start.gg")

# ---- persistence -----------------------------------------------------------
h.handle_ingest(SLUG, 3, REAL_SET)
statep = h.state_path
h3 = hubmod.Hub(key=KEY, token=None, tag_map=tag_map, state_path=statep, log=logs.append)
ok(len(h3.event_view(SLUG)['sets']) == 1, "state survives a hub restart")

# ---- key gate --------------------------------------------------------------
ok(h.check_key(KEY) and not h.check_key('wrong'), "shared key gate works")

# ---- online / ranked games are logged but never reported -------------------
before = len(fake.live_pushes)
ONLINE = dict(REAL_SET, setId='ONLINE1', mode='ONLINE')
h.handle_current(SLUG, 1, {'state': 'set_start'})
res_live = h.handle_live(SLUG, 1, dict(ONLINE, complete=False))
ok(len(fake.live_pushes) == before,
   "an ONLINE set is NOT pushed to start.gg  [%s]" % res_live.get('reason'))
ok('online' in (res_live.get('reason') or ''), "reason names the mode")
h.handle_ingest(SLUG, 1, ONLINE)
orec = h.get_set(SLUG, 1, 'ONLINE1')
ok(orec is not None, "the online set is still recorded (visible in the console)")
ok(orec.get('reportable') is False, "record flagged not reportable")
ok(orec.get('status') == 'online', "status shows the mode  [%s]" % orec.get('status'))
ok(orec.get('matchedStartggSetId') is None,
   "online set is not bound to the station's bracket set")
rep_o = h.do_report(SLUG, 1, 'ONLINE1', 24186345)
ok(isinstance(rep_o, tuple) and rep_o[1] == 409, "reporting an online set is refused (409)")
ok(len(fake.reports) == 1, "no extra start.gg report happened")

RANKED = dict(REAL_SET, setId='RANKED1', mode='RANKED')
h.handle_ingest(SLUG, 1, RANKED)
ok(h.get_set(SLUG, 1, 'RANKED1').get('status') == 'ranked', "ranked labelled too")

# a LOCAL set is unaffected by the new gate
LOCAL = dict(REAL_SET, setId='LOCAL1', mode='LOCAL')
h.handle_ingest(SLUG, 1, LOCAL)
lrec = h.get_set(SLUG, 1, 'LOCAL1')
ok(lrec.get('reportable') is True and lrec.get('matchedStartggSetId') == 105639152,
   "LOCAL sets still match and stay reportable")
bad = ss.Sender(broker=BROKER, slug=SLUG, station=9, out_dir=station_dir,
                state_path=os.path.join(station_dir, 'state2.json'),
                dry_run=False, key='wrong-key')
ok(bad._post('/matchlogger/current', {'slug': SLUG, 'station': 9, 'key': 'wrong-key',
                                      'current': {'state': 'idle'}}) is False,
   "a station with the wrong key is rejected")

server.stop()
shutil.rmtree(workdir, ignore_errors=True)
print('\n' + ('ALL PASS' if fails == 0 else '%d FAILURE(S)' % fails))
sys.exit(1 if fails else 0)

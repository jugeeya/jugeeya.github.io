"""Offline tests for rivals_stats: reader (vs a captured baseline), plus the
de-alias / set-grouping / output-shape logic against today's two real games.
Run: python test_rivals_stats.py [path-to-Rivals2_StatsSaveSlot.sav]
"""
import sys
import rivals_stats as rs

fails = 0


def ok(cond, msg):
    global fails
    print(('PASS' if cond else 'FAIL') + '  ' + msg)
    if not cond:
        fails += 1


def snap(rows):
    CAT = {'matches': 'MatchesByCharacter', 'wins': 'WinsByCharacter', 'losses': 'LossesByCharacter',
           'kos': 'KOsByCharacter', 'deaths': 'DeathsByCharacter', 'damageDealt': 'DamageDealtByCharacter',
           'damageTaken': 'DamageTakenByCharacter', 'grabSuccesses': 'GrabSuccessesByCharacter'}
    flat = {}
    for tag, char, mode, stats in rows:
        for k, v in stats.items():
            flat['%s|%s|%s|%s' % (tag, char, mode, CAT[k])] = v
    return flat


# Game 1 (both Random): KIM rolled Zet & won, JUGZ! rolled Fle & lost.
g1 = snap([('KIM', 'Zet', 'LOCAL', {'matches': 1, 'wins': 1}),
           ('KIM', 'Random', 'LOCAL', {'matches': 1, 'wins': 1}),
           ('JUGZ!', 'Fle', 'LOCAL', {'matches': 1, 'losses': 1}),
           ('JUGZ!', 'Random', 'LOCAL', {'matches': 1, 'losses': 1})])
# Game 2 (both Random): JUGZ! rolled Gal & won w/ stats, KIM rolled Zet & lost.
g2 = snap([('JUGZ!', 'Gal', 'LOCAL', {'matches': 1, 'wins': 1, 'kos': 3, 'damageDealt': 83, 'grabSuccesses': 3}),
           ('JUGZ!', 'Random', 'LOCAL', {'matches': 1, 'wins': 1}),
           ('KIM', 'Zet', 'LOCAL', {'matches': 1, 'losses': 1, 'deaths': 3, 'damageTaken': 83}),
           ('KIM', 'Random', 'LOCAL', {'matches': 1, 'losses': 1})])

r1 = rs.to_game_result(rs.diff({}, g1))
r2 = rs.to_game_result(rs.diff({}, g2))
ok(len(r1['winners']) == 1 and r1['winners'][0]['tag'] == 'KIM' and r1['winners'][0]['char'] == 'Zet',
   'game1 winner KIM (Zet), Random de-aliased')
ok(r1['losers'][0]['char'] == 'Fle', 'game1 loser JUGZ! (Fle)')
ok(not any(s['char'] == 'Random' for s in r2['winners'] + r2['losers']), 'game2 no Random in output')
ok(r2['winners'][0]['stats'].get('kos') == 3 and r2['winners'][0]['stats'].get('damageDealt') == 83,
   'game2 winner carries real stats')
ok('losses' not in r2['winners'][0]['stats'] and 'matches' not in r2['winners'][0]['stats'],
   'bookkeeping fields excluded from per-match stats')

rep1 = rs.parse_replay_name('2026-07-23_19-52-44-606-Player1(Fle)-Player2(Zet)-Game1.rpl')
rep2 = rs.parse_replay_name('2026-07-23_19-56-58-454-Player1(Gal)-Player2(Zet)-Game2.rpl')
ok(rep1['game'] == 1 and rep2['game'] == 2, 'replay GameN parsed (1, 2)')
ok(rep1['players'][0]['char'] == 'Fle' and rep1['players'][1]['char'] == 'Zet', 'replay1 players parsed')

captured = {'sets': []}
import os
import tempfile
outdir = tempfile.mkdtemp(prefix='statstest_')
m = rs._SetMachine(outdir, lambda msg: None)
m.record_game(r1, rep1, rep1['epoch'])
m.record_game(r2, rep2, rep2['epoch'])
ok(m.set is not None and len(m.set['matches']) == 2, 'both games in ONE open set')
g2rec = m.set['matches'][1]
jz = next(p for p in g2rec['players'] if p['name'] == 'JUGZ!')
km = next(p for p in g2rec['players'] if p['name'] == 'KIM')
ok(jz['slot'] == 0 and km['slot'] == 1, 'slots from replay: JUGZ!(Gal)->0, KIM(Zet)->1')
ok(jz['wins'] == 1 and km['wins'] == 1, 'cumulative wins 1-1 after two games')
ok(jz.get('kos') == 3 and jz.get('damageDealt') == 83, 'per-match stats in the record')

report = m.finalize(True, rep2['epoch'] + 5)
import json
files = os.listdir(os.path.join(outdir, 'sets'))
ok(len(files) == 1 and files[0].startswith('set_') and files[0].endswith('.json'), 'one set_<id>.json written')
saved = json.load(open(os.path.join(outdir, 'sets', files[0])))
required = ['setId', 'complete', 'startEpoch', 'endEpoch', 'winsRequired', 'matchCount',
            'winnerSlot', 'winnerName', 'winnerCharacter', 'players', 'matches']
ok(all(k in saved for k in required), 'set file has all mod-contract fields')
ok(saved['matchCount'] == 2, 'set file matchCount=2')
ok(json.load(open(os.path.join(outdir, 'live.json'))).get('complete') is True, 'live.json complete after finalize')
ok(json.load(open(os.path.join(outdir, 'current.json'))).get('state') == 'idle', 'current.json idle after finalize')

# --- backfill: replay race (save flushes before the replay file appears) ---
# The game writes the stats save BEFORE its replay is visible on disk (measured
# 9-16s lag in production data). record_game() must still record the game
# immediately with whatever's known; StatsProducer._backfill_replays() re-checks
# shortly after and fills in what a same-time replay lookup would have given.
import time as _time


def _replay_name(epoch, mid, game):
    t = _time.localtime(epoch)
    return '%04d-%02d-%02d_%02d-%02d-%02d-000-%s-Game%d.rpl' % (
        t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec, mid, game)


bf_out = tempfile.mkdtemp(prefix='statstest_bf_')
bf_replays = tempfile.mkdtemp(prefix='statstest_bf_replays_')
bm = rs._SetMachine(bf_out, lambda msg: None)

# Game A: LOCAL, both players known from the save (uses the earlier r1/rep1).
bm.record_game(r1, rep1, rep1['epoch'])
# Game B: ONLINE, only the local tag (JUGZ!) moved in the save -> single known
# player, and this time NO replay is available yet (the race). JUGZ! loses, so
# the (still unknown) opponent is the winner - this is exactly the case where
# the opponent/character used to be lost forever.
result_b = {'mode': 'ONLINE', 'winners': [],
            'losers': [{'tag': 'JUGZ!', 'char': 'Fle', 'mode': 'ONLINE', 'stats': {'kos': 1}}]}
# Recent wall-clock time (not rep1's fixed 2026-07-23 stamp): _backfill_replays
# gives up on games older than BACKFILL_TIMEOUT_S measured against real time.
at_b = int(_time.time()) - 5
bm.record_game(result_b, None, at_b)

game_b = bm.set['matches'][1]
ok(len(game_b['players']) == 1 and game_b['gameNumber'] is None,
   'backfill setup: game B recorded with no opponent/gameNumber (replay missing at record time)')

# The replay shows up afterwards (deliberately GameN=1, even though this is the
# 2nd game of the still-open set - GameN arriving late must only patch display
# fields, never re-trigger the "new Game1 closes the previous set" boundary).
replay_fname = _replay_name(at_b, 'RIVAL(Zet)-JUGZ!(Fle)', 1)
with open(os.path.join(bf_replays, replay_fname), 'w') as f:
    f.write('')

prod = rs.StatsProducer.__new__(rs.StatsProducer)
prod.replays = bf_replays
prod.log = lambda msg: None
prod.machine = bm
prod._backfill_replays()

ok(bm.set is not None and len(bm.set['matches']) == 2,
   'late GameN=1 backfill does not split/finalize the open set')
game_b = bm.set['matches'][1]
ok(game_b['gameNumber'] == 1, 'gameNumber backfilled onto game B')
ok(len(game_b['players']) == 2, 'opponent backfilled onto game B')
opp = next((p for p in game_b['players'] if p['name'] == 'RIVAL'), None)
ok(opp is not None and opp['character'] == 'Zetterburn', 'backfilled opponent name+character correct')
ok(opp is not None and opp['wins'] == 1, 'backfilled opponent credited the win JUGZ! lost')
jz_b = next(p for p in game_b['players'] if p['name'] == 'JUGZ!')
ok(jz_b['wins'] == 0, "known player's own wins untouched by backfill")
live_after = json.load(open(os.path.join(bf_out, 'live.json')))
ok(live_after['matches'][1]['gameNumber'] == 1, 'live.json reflects the backfilled game')

# Give-up bound: a game older than BACKFILL_TIMEOUT_S is left alone even if a
# matching replay exists, so this can't retry forever.
bm2 = rs._SetMachine(tempfile.mkdtemp(prefix='statstest_bf2_'), lambda msg: None)
at_old = rep1['epoch']
bm2.record_game(result_b, None, at_old)
old_replays = tempfile.mkdtemp(prefix='statstest_bf2_replays_')
with open(os.path.join(old_replays, _replay_name(at_old, 'RIVAL(Zet)-JUGZ!(Fle)', 1)), 'w') as f:
    f.write('')
prod2 = rs.StatsProducer.__new__(rs.StatsProducer)
prod2.replays = old_replays
prod2.log = lambda msg: None
prod2.machine = bm2
# Pretend this game was recorded well beyond the backfill window by back-dating
# its endEpoch, rather than sleeping BACKFILL_TIMEOUT_S seconds in a test.
bm2.set['matches'][0]['endEpoch'] = int(_time.time()) - rs.StatsProducer.BACKFILL_TIMEOUT_S - 5
prod2._backfill_replays()
ok(len(bm2.set['matches'][0]['players']) == 1 and bm2.set['matches'][0]['gameNumber'] is None,
   'a too-old game is left un-backfilled (gives up after BACKFILL_TIMEOUT_S)')

# Optional: reader parity if a real save is provided
if len(sys.argv) > 1:
    flat = rs.parse_stats(open(sys.argv[1], 'rb').read())
    ok(len(flat) > 0 and all('|' in k for k in flat), 'parse_stats reads the real save (%d keys)' % len(flat))
    ok(all(t not in rs.SYNTHETIC for t in rs.tag_names(flat)), 'synthetic tags (ALL TAGS/CUM) filtered out')

print('\n' + ('ALL PASS' if fails == 0 else '%d FAILURE(S)' % fails))
sys.exit(1 if fails else 0)

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

# Optional: reader parity if a real save is provided
if len(sys.argv) > 1:
    flat = rs.parse_stats(open(sys.argv[1], 'rb').read())
    ok(len(flat) > 0 and all('|' in k for k in flat), 'parse_stats reads the real save (%d keys)' % len(flat))
    ok(all(t not in rs.SYNTHETIC for t in rs.tag_names(flat)), 'synthetic tags (ALL TAGS/CUM) filtered out')

print('\n' + ('ALL PASS' if fails == 0 else '%d FAILURE(S)' % fails))
sys.exit(1 if fails else 0)

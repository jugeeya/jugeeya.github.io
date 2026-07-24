"""Tests for matching.py, built around the real 2-0 set that exposed the
live-score bug (JUGZ!/Orcane 2-0 KIM/Galvan, entrants jugeeya + Kimchi).

Run: python test_matching.py
"""
import sys

import matching as m

fails = 0


def ok(cond, msg):
    global fails
    print(('PASS' if cond else 'FAIL') + '  ' + msg)
    if not cond:
        fails += 1


# ---- the real set, as the station writes it -------------------------------
REAL_SET = {
    'setId': '20260724_075508', 'complete': True, 'matchCount': 2,
    'winnerSlot': 0, 'winnerName': 'JUGZ!', 'winnerCharacter': 'Orc',
    'players': [
        {'slot': 0, 'name': 'JUGZ!', 'character': 'Orc', 'wins': 2},
        {'slot': 1, 'name': 'KIM', 'character': 'Gal', 'wins': 0},
    ],
    'matches': [
        {'index': 1, 'players': [
            {'slot': 0, 'name': 'JUGZ!', 'character': 'Orc', 'wins': 1},
            {'slot': 1, 'name': 'KIM', 'character': 'Gal', 'wins': 0}]},
        {'index': 2, 'players': [
            {'slot': 0, 'name': 'JUGZ!', 'character': 'Orc', 'wins': 2},
            {'slot': 1, 'name': 'KIM', 'character': 'Gal', 'wins': 0}]},
    ],
}
ENTRANTS = [{'id': 24186345, 'name': 'jugeeya'}, {'id': 24186347, 'name': 'Kimchi'}]
TAGS = m.build_tag_map({'JUGZ!': 'jugeeya', 'KIM': 'Kimchi', 'BRUJITA': 'Brujita'})
# start.gg's character list is full names; the save may send codes or full names.
CHARS = {'orcane': 41, 'galvan': 42, 'clairen': 43, 'ranno': 44, 'random': 99, 'fleet': 45}

# ---- basics ----------------------------------------------------------------
ok(m.norm('JUGZ!') == 'jugz', "norm strips punctuation")
ok(m.entrant_names({'name': 'TEAM | jugeeya'}) == ['TEAM | jugeeya', 'jugeeya'],
   "entrant_names splits a sponsor prefix")
ok(TAGS.get('jugz') == 'jugeeya', "build_tag_map normalizes its keys")
ok(m.player_aliases({'name': 'JUGZ!'}, TAGS) == ['jugeeya', 'JUGZ!'],
   "player_aliases resolves a save tag through players.json")

# ---- winner match ----------------------------------------------------------
wid, conf = m.match_winner(REAL_SET, ENTRANTS, TAGS)
ok(wid == 24186345 and conf == 'high', "winner JUGZ! -> jugeeya with high confidence")
wid_nomap, conf_nomap = m.match_winner(REAL_SET, ENTRANTS, None)
ok(conf_nomap == 'none', "without players.json, JUGZ! vs jugeeya is honestly 'none'")

# ---- per-game derivation (the 2-0 regression) ------------------------------
games = m.derive_games(REAL_SET)
ok(len(games) == 2, "two games derived")
ok([g['winnerSlot'] for g in games] == [0, 0], "both games won by slot 0")
ok(games[1]['gameNum'] == 2, "game numbers preserved")

# ---- slot -> entrant mapping ----------------------------------------------
rec = {'entrants': ENTRANTS, 'set': m.summarize_set(REAL_SET)}
smap = m.map_slots_to_entrants(rec, None, TAGS)
ok(smap == {0: '24186345', 1: '24186347'}, "live mapping by tag: slot0=jugeeya slot1=Kimchi  [%s]" % smap)

rec_swapped = dict(rec, swap=True)
ok(m.map_slots_to_entrants(rec_swapped, None, TAGS) == {0: '24186347', 1: '24186345'},
   "swap inverts the mapping")

fin = m.map_slots_to_entrants(rec, 24186345, TAGS)
ok(fin == {0: '24186345', 1: '24186347'}, "finalizing anchors the winner's slot")

# unknown tags still map (by order) rather than refusing
rec_unknown = {'entrants': ENTRANTS, 'set': m.summarize_set(dict(
    REAL_SET, players=[{'slot': 0, 'name': 'ZZZ', 'character': 'Orc', 'wins': 2},
                       {'slot': 1, 'name': 'YYY', 'character': 'Gal', 'wins': 0}]))}
ok(m.map_slots_to_entrants(rec_unknown, None, TAGS) is not None,
   "unknown names still pair by order (never refuse a live score)")

# ---- character ids ---------------------------------------------------------
ok(m.char_id_for(CHARS, 'Orc') == 41, "3-letter code 'Orc' -> Orcane by unique prefix")
ok(m.char_id_for(CHARS, 'Orcane') == 41, "full name 'Orcane' -> exact")
ok(m.char_id_for(CHARS, 'Ran') == 44, "'Ran' prefers Ranno over Random")
ok(m.char_id_for(CHARS, 'Random') == 99, "'Random' exact-matches Random")
ok(m.char_id_for(CHARS, 'Nope') is None, "unknown character -> None")

# ---- start.gg gameData (what actually gets pushed) -------------------------
gd = m.game_data_from_games(games, smap, CHARS)
ok(len(gd) == 2, "gameData covers both games")
ok(all(g.get('winnerId') == '24186345' for g in gd),
   "BOTH games carry a winnerId (the bug that froze start.gg at 1-0)")
ok(gd[0]['selections'] == [{'entrantId': '24186345', 'characterId': 41},
                           {'entrantId': '24186347', 'characterId': 42}],
   "character selections resolved per entrant")

print('\n' + ('ALL PASS' if fails == 0 else '%d FAILURE(S)' % fails))
sys.exit(1 if fails else 0)

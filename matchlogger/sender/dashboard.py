"""Console scoreboard for the station sender's stats mode (stdlib only).

Renders the sets seen this session as a live table:

    Time    Tag        start.gg     Character       Score
    19:52   JUGZ!      jugeeya      Fleet             2  *   final
            KIM        Kimchi       Zetterburn        1

The star marks the set winner; in-progress sets show "live". The start.gg column
comes from an optional alias map (save-tag -> start.gg tag); "-" when unknown.
"""
import os
import time
from collections import deque

from rivals_stats import char_full

_W = 74


class Dashboard:
    def __init__(self, station, slug, mode_label, aliases=None):
        self.station = station
        self.slug = slug
        self.mode = mode_label
        self.aliases = aliases or {}
        self.snap = {'history': [], 'live': None}
        self.activity = deque(maxlen=8)

    # -- inputs --------------------------------------------------------------
    def update(self, snap):
        self.snap = snap
        self.render()

    def log(self, msg):
        self.activity.append((time.strftime('%H:%M:%S'), msg))
        self.render()

    # -- rendering -----------------------------------------------------------
    def _line(self):
        return '  ' + '-' * _W

    def _block(self, s):
        t = time.strftime('%H:%M', time.localtime(s['startEpoch']))
        status = 'live' if not s['complete'] else 'final'
        for i, p in enumerate(s['players']):
            gg = self.aliases.get(p['tag'], '-')
            mark = '*' if p.get('won') else ' '
            print('  %-6s  %-9s  %-11s  %-13s  %3d %s  %s' % (
                t if i == 0 else '', p['tag'][:9], gg[:11], char_full(p['char'])[:13],
                p['wins'], mark, status if i == 0 else ''))
        print()

    def render(self):
        os.system('cls' if os.name == 'nt' else 'clear')
        print()
        print('  Rivals 2 - Station Sender      station %s - %s - %s'
              % (self.station, self.slug, self.mode))
        print(self._line())
        print('  %-6s  %-9s  %-11s  %-13s  %5s' % ('Time', 'Tag', 'start.gg', 'Character', 'Score'))
        print(self._line())
        sets = list(self.snap.get('history', []))
        live = self.snap.get('live')
        if live:
            sets.append(live)
        if not sets:
            print('   (waiting for a game - play a set and it will appear here)')
            print()
        else:
            for s in sets:
                self._block(s)
        print(self._line())
        print('  recent activity:')
        if not self.activity:
            print('    -')
        for t, m in list(self.activity)[-6:]:
            print('    %s  %s' % (t, m))
        print()

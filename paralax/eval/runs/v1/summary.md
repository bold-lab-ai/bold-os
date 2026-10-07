run v1 | algorithm ['v1'] | sessions 84

| arm | sessions | individual acc (mid) | individual acc (final) | plurality correct | holder said fact | fact reached another person | credited to holder | misattributed | assistant calls / session |
|---|---|---|---|---|---|---|---|---|---|
| isolated | 24 | 0.14 | 0.14 | 0.00 | 86/94 | 1/94 | 0/94 | 0/94 | 30 |
| context | 24 | 0.73 | 0.91 | 0.96 | 88/94 | 89/94 | 88/94 | 2/94 | 30 |
| workspace | 24 | 0.60 | 0.63 | 0.58 | 85/94 | 83/94 | 80/94 | 3/94 | 60 |
| full | 12 | 0.93 | 0.97 | 1.00 | - | - | - | - | 30 |

workspace - isolated: 24 paired sessions | individual acc +0.483 (one-sided p = 0.000) | plurality +0.583 (p = 0.000)
workspace - context: 24 paired sessions | individual acc -0.283 (one-sided p = 1.000) | plurality -0.375 (p = 1.000)
context - isolated: 24 paired sessions | individual acc +0.767 (one-sided p = 0.000) | plurality +0.958 (p = 0.000)
noise isolated: mean |seed0 - seed1| individual acc = 0.083 over 12 tasks
noise workspace: mean |seed0 - seed1| individual acc = 0.350 over 12 tasks
noise context: mean |seed0 - seed1| individual acc = 0.150 over 12 tasks
workspace selection: status {'ok': 700, 'timeout': 20} | relations {'overlaps': 7, 'contradicts': 315, 'answers': 64, 'supports': 63} | picks/session 18.7 | asks/session 0.6

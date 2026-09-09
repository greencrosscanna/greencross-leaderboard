#!/usr/bin/env sh
# American English, on the lines a change ADDS.
#
#   ./gx-usenglish.sh            check what this push would introduce (working tree vs upstream)
#   git diff X | ./gx-usenglish.sh -    check a diff handed in on stdin
#
# WHY THIS EXISTS. Sky's standing rule is American English everywhere — chat, code comments, commit
# messages, PR bodies. It lives in ~/.claude/CLAUDE.md and loads at the start of every session, and on
# 2026-09-07 a session read it and then wrote "coloured" into gx-theme.css an hour later. Sky caught
# it on screen. A rule that is already in front of you on every turn and still gets broken is not a
# rule that needs restating; it needs a gate, which is what every other must-stay-true property in
# this suite has — credential literals, date handling, dev leftovers.
#
# His own diagnosis of how the drift happened is the design brief: "nobody chose that; it accumulated
# one word at a time and then got copied forward by the next session reading the last one." So the
# check is on ADDED lines. It cannot ask anyone to rewrite what is already there, which is explicitly
# not wanted — an identifier, CSS class or sheet column named the British way is a NAME, and renaming
# names breaks things for a spelling.
#
# THE WORD LIST IS SHORT ON PURPOSE. Every entry is prose-only: a word that is never an identifier,
# never a CSS keyword, never an HTML attribute. `grey`, `centre`, `licence`, `defence` and `catalogue`
# are all deliberately ABSENT — grey is a real CSS color keyword, and the others show up inside
# domain names and vendor code often enough to make this noisy. A noisy gate is one people learn to
# bypass, and then it protects nothing; that is the same reason gxripple.sh works hard to tell a
# person from your own wake.
set -u

if [ "${1:-}" = "-" ]; then
  DIFF="$(cat)"
else
  # Everything this push would introduce: the working tree measured against the upstream branch, so
  # committed-but-unpushed work counts too. Falls back to uncommitted-only when there is no upstream
  # (a fresh branch), which is the safe direction — it checks less, never more.
  if UP="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" && [ -n "$UP" ]; then
    DIFF="$(git diff "$UP" 2>/dev/null)"
  else
    DIFF="$(git diff HEAD 2>/dev/null)"
  fi
fi

# The diff goes to a temp file rather than down a pipe, so the Python below can live in a QUOTED
# heredoc. The first cut used `python3 -c` with a single-quoted program, and the program contained
# the word "Sky's" — which closed the shell string and produced a syntax error. Caught by the test on
# its first run, which is the argument for writing the test alongside the gate rather than after it.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT INT TERM
printf '%s' "$DIFF" > "$TMP"

python3 - "$TMP" <<'PY'
import sys, re

# A STEM IS NOT A WORD, and matching one as a bare substring is how this gate told a correct author
# to write "optimiztic". Every entry below used to be tested with `brit in line`, so "optimis" fired
# inside optimistic / optimism / optimist -- spelled that way in American English too. It blocked a
# real push in greencross-crew on 2026-09-08 and the author bypassed the whole hook with --no-verify,
# taking the credential scan and the tests with it.
#
# That is the failure this gate cannot survive. Every other entry names a word that really IS British,
# so obeying the gate improves the text; here obeying it would produce a misspelling. A rule a correct
# author cannot satisfy gets bypassed by habit, and then it is not a gate -- the same noise argument
# that keeps `grey` and `centre` off the list below.
#
# So an -ise stem must be followed by an ending that only the BRITISH form takes. Sweeping the rest of
# the list for the same shape found three more live false positives beyond the reported one:
# "organis" inside organism and organist, and "apologis" inside apologist.
ISE_END = r"(?:e|es|ed|ing|er|ers|ation|ations|ational|able|ably|ability)"

# The lookahead is `(?![a-z])` rather than `\b`, and what it buys is narrower than it looks. Lines are
# LOWERCASED before any pattern runs (see below), so `optimiseData` is `optimisedata` by the time this
# sees it and the lookahead refuses the match. An -ise stem therefore CANNOT reach inside a camelCase
# identifier, and that is the correct behavior, not a gap: Sky's rule is explicit that an identifier,
# CSS class, JSON key or sheet column named the British way is a NAME, and renaming names breaks
# things for a spelling. Reaching them would mean dropping the lowercase pass and making every pattern
# case-aware, which would start failing pushes over names.
#
# BE AWARE OF THE ASYMMETRY rather than surprised by it: a `plain` entry is a bare substring and DOES
# fire inside an identifier — `colourPicker` is flagged, and the test asserts that deliberately, on
# the grounds that a NEW identifier is still ours to spell correctly. So the two kinds of entry treat
# names differently. Corrected 2026-09-08: this comment previously claimed the opposite of what the
# code does, and greencross-crew measured it and said so. A comment that overstates a gate invites
# someone to "restore" a capability that never existed, or to file a bug when a name sails through.
def ise(stem, amer):
    return (re.compile(stem + ISE_END + r"(?![a-z])"), stem, amer)

# Plain entries: substrings no American word contains, so they need no ending. `colour` has to keep
# matching colours / coloured / colourful, which is exactly what a bare stem is right for.
def plain(word, amer):
    return (re.compile(re.escape(word)), word, amer)

SWAPS = [
    plain("colour",    "color"),      plain("behaviour", "behavior"),
    plain("favour",    "favor"),      plain("honour",    "honor"),
    plain("whilst",    "while"),      plain("amongst",   "among"),
    ise("summaris",    "summariz"),   ise("authoris",    "authoriz"),
    ise("normalis",    "normaliz"),   ise("prioritis",   "prioritiz"),
    ise("organis",     "organiz"),    ise("recognis",    "recogniz"),
    ise("apologis",    "apologiz"),   ise("optimis",     "optimiz"),
    ise("utilis",      "utiliz"),     ise("initialis",   "initializ"),
    plain("centred",   "centered"),   plain("cancelled", "canceled"),
    plain("modelling", "modeling"),   plain("travelled", "traveled"),
    plain("labelled",  "labeled"),

    # The stem here is "analys", not "analyse" -- the gerund is analysING, so anchoring on the longer
    # stem would silently miss it. Deliberately NOT "analyses": that is the correct American plural of
    # "analysis" ("the analyses agree") as well as the British verb, and the noun is common enough here
    # that flagging it would be noise. One British verb form goes uncaught to buy that.
    (re.compile(r"analys(?:e|ed|ing|er|ers)(?![a-z])"), "analyse", "analyze"),

    # fulfil / fulfils / fulfilment, but never the American "fulfill". This used to be the literal
    # "fulfil " with a trailing space, which missed "fulfilment" and any line ending in "fulfil.".
    (re.compile(r"fulfil(?!l)"), "fulfil", "fulfill"),
]

# aria-labelledby is a real HTML attribute -- an identifier, not prose, and it is in spiff's shipped
# index.html today. A gate that flagged it would have failed a real push on its first day.
IDENTIFIER_OK = re.compile(r"aria-labelledby|labelledby")

# THIS CHECKER AND ITS TEST ARE EXEMPT, and the reason is not convenience. Their content IS the word
# list: the table below and the fixtures that exercise it are necessarily full of British spellings.
# Without this the gate fails on itself and can never be edited -- the same exemption every spell
# checker grants its own dictionary. Named by exact path rather than a pattern, so the hole is two
# files wide and cannot quietly grow.
SELF = ("gx-usenglish.sh", "tests/american_english_test.js")

hits = []
path = None
skip = False
for line in open(sys.argv[1], encoding="utf-8", errors="replace").read().split("\n"):
    if line.startswith("+++ b/"):
        path = line[6:]
        skip = path.endswith(SELF)
        continue
    if skip:
        continue
    if not line.startswith("+") or line.startswith("+++"):
        continue
    body = line[1:]
    low = IDENTIFIER_OK.sub("", body).lower()
    for rx, brit, amer in SWAPS:
        if rx.search(low):
            hits.append((path or "?", brit, amer, body.strip()[:96]))
            break

if hits:
    print("  x British spellings on added lines (the rule: American English everywhere):")
    for p, brit, amer, text in hits:
        print("      %s" % p)
        print("        \"%s\" -> \"%s\"   %s" % (brit, amer, text))
    print("      Only ADDED lines are checked. Existing text is left alone on purpose --")
    print("      renaming an identifier for a spelling breaks things; fix prose freely.")
    sys.exit(1)
sys.exit(0)
PY

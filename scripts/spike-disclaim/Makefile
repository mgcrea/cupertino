# Spike 2: build and sign the disclaim probe.
#
# Signing matters more than it looks. TCC identifies an unsigned or ad-hoc
# binary by its cdhash, so it would lose its Full Disk Access grant on every
# rebuild. Signing with a real identity under a stable identifier gives it a
# designated requirement that survives recompilation.

IDENTITY ?= Apple Development: Olivier Louvignes (493B6W4L7C)
BUNDLE_ID ?= io.mgcrea.apple-mail-mcp.fda-probe

fda-probe: fda-probe.c
	clang -O0 -g -Wall -Wextra -o $@ $<
	codesign --force --sign "$(IDENTITY)" --identifier "$(BUNDLE_ID)" --options runtime $@
	@echo
	@codesign -dv $@ 2>&1 | grep -E 'Identifier|TeamIdentifier|Authority=Apple Dev' || true

clean:
	rm -rf fda-probe fda-probe.dSYM

.PHONY: clean

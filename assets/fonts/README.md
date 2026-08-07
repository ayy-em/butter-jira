# Bundled fonts

**Ubuntu Sans** and **Ubuntu Sans Mono**, Canonical's official pre-built webfont
builds, taken unmodified from:

- https://github.com/canonical/Ubuntu-Sans-fonts (`fonts/webfont/UbuntuSans[wdth,wght].woff2`)
- https://github.com/canonical/Ubuntu-Sans-Mono-fonts (`fonts/webfont/UbuntuSansMono[wght].woff2`)

Only the *filenames* were changed — the bracketed axis suffix needs escaping in
a CSS `url()`, and a filename is not the typeface name. The font software
itself, including its internal family names, is byte-for-byte Canonical's.

## Licence

**Ubuntu Font Licence 1.0** — see `LICENCE.txt`, which is Canonical's own copy.
Not the SIL OFL; the Ubuntu family has never been released under it.

The licence expressly permits what is done here: *"The fonts, including any
derivative works, can be bundled, embedded, and redistributed provided the
terms of this licence are met."* The terms that apply to us:

- **Ship the licence.** `LICENCE.txt` sits beside the fonts and is included in
  every build (`scripts/build.mjs`), which is why `assets/fonts/` is not in the
  excluded-assets list.
- **Do not rename the fonts.** We have not modified them, so they keep their
  names. If anyone ever subsets or re-hints these files, the UFL requires the
  result to be renamed — at which point copy them somewhere else rather than
  editing these in place.
- **The fonts stay under the UFL.** That obligation is on the font files, not
  on this project: the licence states explicitly that it "does not require any
  document created using the fonts or their derivatives to be published under
  this licence".

## Why variable, and why these two files

One file per family covers every weight the app uses (400/500/600) and the full
character set, including the accented and Cyrillic names that turn up in a real
roster. Static instances at three weights each would have been six files and
about 100 KB more.

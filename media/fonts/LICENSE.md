# Bundled icon font

`makecode-icons.woff2` is **Font Awesome 4.7.0** (`fontawesome-webfont.woff2`).

MakeCode's toolbox category metadata refers to its icons by codepoint — ``
for Sprites, `` for Controller, and so on. Those are Font Awesome 4
codepoints: MakeCode renders them with the Semantic UI icon font, which is
derived from Font Awesome and shares its code points. Font Awesome 4.7 is used
here instead because the font files shipped in the `pxt-core` npm package fail
to decode in Chromium ("OTS parsing error: Failed to convert WOFF 2.0 font to
SFNT"), while Font Awesome's own release loads correctly and draws the same
glyphs.

- Font: **Font Awesome 4.7.0** by Dave Gandy — https://fontawesome.com
- Font files licensed under **SIL OFL 1.1** — https://scripts.sil.org/OFL

The file is redistributed unmodified.

// The placeholder rule for handed-back commands (Tasks > Commands), shared by the Mac and the phone.
//
// The pattern uses regex lookbehind, which WebKit only parses from Safari / iOS 16.4. The phone app supports iOS 15,
// and a regex LITERAL it cannot parse is a SyntaxError for the whole bundle (nothing loads, not even pairing). So the
// pattern is kept as a string and compiled on first use, and an engine that cannot compile it gets `undefined`
// ("cannot tell here") instead: the phone then relies on the Mac, which always checks again before it runs anything.
//
// Each rule leaves real shell syntax alone: <name> but not a heredoc (<<EOF >file) or <(...); YOUR_/your- after a
// prefix too (ghp_YOUR_TOKEN); x's on their own or 4+ in a value (sk_test_xxxx) but not mktemp's .XXXXXX; `...` only
// as a token of its own, never git's main...HEAD. The card still offers "run as is" for anything it gets wrong.
const PLACEHOLDER_SOURCE = String.raw`(?<!<)<[A-Za-z][\w .:/-]{0,40}>|(?<![A-Za-z])YOUR[_-][A-Z0-9_-]+|(?<![A-Za-z])your[-_][a-z0-9_-]+|(?<![A-Za-z0-9.])[xX]{3}(?![A-Za-z0-9])|(?<![.xX])[xX]{4,}|(?<=^|[\s"'=])\.\.\.(?=[\s"']|$)`;

let compiled; // undefined: not tried yet; null: this engine cannot compile it
function placeholderRe() {
  if (compiled === undefined) {
    try { compiled = new RegExp(PLACEHOLDER_SOURCE); } catch { compiled = null; }
  }
  return compiled;
}

/**
 * The first placeholder in a handed-back command that has to be filled in before it can run (`<your-key>`,
 * YOUR_TOKEN, your-repo, xxx, ...), null when there is none, or undefined when this JavaScript engine cannot tell
 * (an old iPhone). Tasks > Commands keeps Run off until it is edited out.
 */
export function commandPlaceholder(text) {
  const re = placeholderRe();
  if (!re) return undefined;
  const m = re.exec(String(text || ''));
  return m ? m[0] : null;
}

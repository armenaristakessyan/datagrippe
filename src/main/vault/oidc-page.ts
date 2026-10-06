// Page shown in the browser at the end of a Vault OIDC sign-in (self-contained: no external assets).

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

export function oidcResultPage(ok: boolean, detail?: string): string {
  const title = ok ? 'Signed in to Vault' : 'Vault sign-in failed'
  const message = ok ? 'You can close this tab and go back to DataGrippe.' : (detail ?? 'Go back to DataGrippe and try again.')
  const mark = ok
    ? '<path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<path d="M8.5 8.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — DataGrippe</title>
<style>
  :root { color-scheme: light dark; --bg: #eceef1; --card: #ffffff; --fg: #17181c; --muted: #5c6270; --line: #d9dce2; --ok: #1f9d55; --bad: #d14343; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d0e11; --card: #16181d; --fg: #e8eaee; --muted: #9aa0ad; --line: #262a32; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; padding: 16px; }
  main { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 28px 24px; text-align: center; box-shadow: 0 12px 32px rgba(0,0,0,.12); }
  svg { width: 40px; height: 40px; color: ${ok ? 'var(--ok)' : 'var(--bad)'}; }
  .ring { fill: none; stroke: currentColor; stroke-width: 1.75; opacity: .35; }
  h1 { font-size: 16px; font-weight: 600; margin: 12px 0 6px; }
  p { margin: 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .brand { margin-top: 20px; font-size: 11px; color: var(--muted); letter-spacing: .02em; }
</style>
</head>
<body>
<main>
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle class="ring" cx="12" cy="12" r="10.5"/>${mark}</svg>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <div class="brand">DataGrippe</div>
</main>
</body>
</html>`
}

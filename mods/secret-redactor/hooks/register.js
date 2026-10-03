// Renser secrets fra tool-resultater, før Claude læser dem (#235).
// Ren tekstudskiftning: ingen fil-, netværks- eller proces-kald (mods er ikke sandboxede).

// Hvert mønster bevarer nøglen (gruppe 1) og erstatter kun værdien.
// ponytail: regex-baseret, så et token i et ukendt format slipper igennem.
export const PATTERNS = [
  /(MINERU_API_TOKEN\\?["']?\s*[=:]\s*\\?["']?)[^\s"'&\\]+/gi,
  /(access_token=)[^&\s"'<>\\]+/gi,
  /(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi,
  /(__ITSL_CSRF_TOKEN__\\?["']?\s*[=:]\s*\\?["']?)[^\s"'&;,\\]+/gi,
  /((?:Set-)?Cookie:[ \t]*)[^\r\n]*/gi,
]

export const redact = (s) => PATTERNS.reduce((t, re) => t.replace(re, '$1[REDACTED]'), s)

// Gennemgår strenge i hele resultatet (text, result, content[].text …).
export const scrub = (v) => {
  if (typeof v === 'string') return redact(v)
  if (Array.isArray(v)) return v.map(scrub)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
  }
  return v
}

export function register(on) {
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined) return r
    try {
      // `ref`/`text` er kernens egne, uskrubbede beskeder: core bruger dem ordret, hvis de
      // returneres uændret. Derfor droppes de, så kernen mapper det rensede `result` påny.
      const { ref, text, ...rest } = r
      const out = scrub(rest)
      return r.isError ? { ...out, text: scrub(text) } : out
    } catch {
      // Fail-closed: hellere ingen output end urenset output.
      return { deny: 'secret-redactor: kunne ikke rense output, resultatet er holdt tilbage.' }
    }
  })
}

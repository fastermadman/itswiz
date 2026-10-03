import { expect, test } from 'claude-code/testing'
import { redact } from '../hooks/register.js'

// Ét felt pr. mønster: falsk input → forventet output. Fjernes et mønster, fejler netop dets række.
const CASES: [string, string, string][] = [
  ['MINERU_API_TOKEN', 'MINERU_API_TOKEN=fake-mineru-0123456789', 'MINERU_API_TOKEN=[REDACTED]'],
  ['access_token', 'https://wopi.example/contents?access_token=fakewopi0123&x=1', 'https://wopi.example/contents?access_token=[REDACTED]&x=1'],
  ['Bearer', 'Authorization: Bearer fake.bearer-0123456789', 'Authorization: Bearer [REDACTED]'],
  ['__ITSL_CSRF_TOKEN__', '{"__ITSL_CSRF_TOKEN__": "fakecsrf0123"}', '{"__ITSL_CSRF_TOKEN__": "[REDACTED]"}'],
  ['Cookie', 'Cookie: itsl=fakesession0123; other=1\nHost: x', 'Cookie: [REDACTED]\nHost: x'],
  ['Set-Cookie', 'Set-Cookie: itsl=fakesession0123; Path=/', 'Set-Cookie: [REDACTED]'],
]

for (const [name, input, expected] of CASES) {
  test(`redact: ${name}`, async () => {
    expect(redact(input)).toBe(expected)
  })
}

test('tool.call-hooken renser både result og text', async ($, on) => {
  on('tool.call', () => ({ result: { stdout: 'MINERU_API_TOKEN=fake-mineru-0123456789' } }))
  const r: any = await $.tool.call({ tool: 'Bash', command: 'cat watchfolder/.env' })
  expect(JSON.stringify(r)).not.toContain('fake-mineru')
  expect(JSON.stringify(r)).toContain('MINERU_API_TOKEN=[REDACTED]')
})

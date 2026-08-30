/** Single-sample LAN-trust resolution for the /api browser-trust fence (`resolveLanTrust`). */

import { describe, expect, it, vi } from 'vitest'
import { resolveLanTrust } from '../src/index.ts'

vi.mock('node:os', () => ({
  networkInterfaces: () => ({
    lo0: [
      { family: 'IPv4', internal: true, address: '127.0.0.1' },
    ],
    en0: [
      { family: 'IPv6', internal: false, address: 'fe80::1' },
      { family: 'IPv4', internal: false, address: '192.168.1.5' },
    ],
    en1: [
      { family: 'IPv4', internal: false, address: '10.0.0.7' },
    ],
    'Radmin VPN': [
      { family: 'IPv4', internal: false, address: '26.156.154.127' },
    ],
    'vEthernet (Default Switch)': [
      { family: 'IPv4', internal: false, address: '172.31.112.1' },
    ],
    WLAN: [
      { family: 'IPv4', internal: false, address: '192.168.1.6' },
    ],
    utun0: undefined,
  }),
}))

describe('resolveLanTrust', () => {
  it('samples non-internal IPv4 addresses for display without granting them before sharing is enabled', () => {
    const { lanAddresses, trustedHosts } = resolveLanTrust('0.0.0.0', ['harness.internal:3080'])
    expect(lanAddresses).toEqual(['192.168.1.5', '10.0.0.7', '192.168.1.6'])
    expect(trustedHosts).toEqual(['harness.internal:3080'])
  })

  it('derives nothing for a loopback bind — extras alone stand, no LAN URL to print', () => {
    expect(resolveLanTrust('127.0.0.1', [])).toEqual({ lanAddresses: [], trustedHosts: [] })
    expect(resolveLanTrust('127.0.0.1', ['lab.internal']))
      .toEqual({ lanAddresses: [], trustedHosts: ['lab.internal'] })
  })
})

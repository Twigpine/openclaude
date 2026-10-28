import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto'

// Minimal DER encoding for this test certificate, including long-form lengths.
function der(tag: number, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts)
  const length: number[] = []
  if (content.length < 128) {
    length.push(content.length)
  } else {
    for (let remaining = content.length; remaining > 0; remaining >>>= 8) {
      length.unshift(remaining & 0xff)
    }
    length.unshift(0x80 | length.length)
  }
  return Buffer.concat([Buffer.from([tag, ...length]), content])
}

const sequence = (...parts: Buffer[]) => der(0x30, ...parts)
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'))
const booleanTrue = der(0x01, Buffer.from([0xff]))

function certificateTime(date: Date): Buffer {
  const digits = date.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z')
  // X.509 uses UTCTime for 1950–2049 and GeneralizedTime otherwise.
  const utc = date.getUTCFullYear() >= 1950 && date.getUTCFullYear() < 2050
  return der(utc ? 0x17 : 0x18, Buffer.from(utc ? digits.slice(2) : digits))
}

function extension(oidHex: string, value: Buffer, critical = false): Buffer {
  return sequence(
    oid(oidHex),
    ...(critical ? [booleanTrue] : []),
    der(0x04, value),
  )
}

export function createTestTlsFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  })
  // AlgorithmIdentifier for ecdsa-with-SHA256 (1.2.840.10045.4.3.2).
  const algorithm = sequence(oid('2a8648ce3d040302'))
  const name = sequence(der(0x31, sequence(
    oid('550403'), // commonName (2.5.4.3)
    der(0x0c, Buffer.from('localhost')),
  )))
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const tbsCertificate = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), // explicit v3 version
    der(0x02, Buffer.from([1])), // positive serial, unique for this fresh issuer
    algorithm,
    name, // issuer and subject are identical for a self-signed certificate
    sequence(certificateTime(new Date(now - day)), certificateTime(new Date(now + day))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(
      extension('551d13', sequence(booleanTrue), true), // basicConstraints: CA
      // keyUsage: digitalSignature + keyCertSign; two unused bits.
      extension('551d0f', der(0x03, Buffer.from([2, 0x84])), true),
      extension('551d11', sequence( // subjectAltName
        der(0x82, Buffer.from('localhost')),
        der(0x87, Buffer.from([127, 0, 0, 1])),
      )),
    )),
  )
  const certificate = sequence(
    tbsCertificate,
    algorithm,
    der(0x03, Buffer.from([0]), sign('sha256', tbsCertificate, privateKey)),
  )
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: new X509Certificate(certificate).toString(),
    publicKey,
  }
}

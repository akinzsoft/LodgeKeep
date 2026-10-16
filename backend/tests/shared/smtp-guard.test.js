'use strict';

const dns = require('dns').promises;
const {
  isBlockedAddress,
  assertAllowedPort,
  resolveSafeSmtpHost,
  sanitizeDisplayName,
  isSingleEmailAddress,
  scrubSecrets,
} = require('../../src/shared/smtp-guard');

describe('smtp-guard', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.SMTP_ALLOW_PRIVATE_HOSTS;
  });

  describe('SSRF: blocked addresses', () => {
    it.each([
      '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', 'ff02::1',
    ])('blocks %s', (ip) => {
      expect(isBlockedAddress(ip)).toBe(true);
    });

    it.each(['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    });
  });

  describe('resolveSafeSmtpHost', () => {
    it('refuses a literal private address and localhost without touching DNS', async () => {
      const lookup = jest.spyOn(dns, 'lookup');
      await expect(resolveSafeSmtpHost('127.0.0.1')).rejects.toMatchObject({ code: 'VALIDATION_SMTP_HOST_REJECTED' });
      await expect(resolveSafeSmtpHost('localhost')).rejects.toMatchObject({ code: 'VALIDATION_SMTP_HOST_REJECTED' });
      await expect(resolveSafeSmtpHost('[::1]')).rejects.toMatchObject({ code: 'VALIDATION_SMTP_HOST_REJECTED' });
      expect(lookup).not.toHaveBeenCalled();
    });

    it('refuses a name that resolves to ANY private address (DNS pointing inward)', async () => {
      jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.1.1.1', family: 4 }]);
      await expect(resolveSafeSmtpHost('mail.evil.example')).rejects.toMatchObject({ code: 'VALIDATION_SMTP_HOST_REJECTED' });
    });

    it('returns the checked address for a public host, so the caller connects to it', async () => {
      jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.114.9', family: 4 }]);
      await expect(resolveSafeSmtpHost('Mail.Example.com')).resolves.toEqual({ address: '203.0.114.9', family: 4 });
    });

    it('reports an unresolvable host plainly', async () => {
      jest.spyOn(dns, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));
      await expect(resolveSafeSmtpHost('nope.example')).rejects.toMatchObject({ code: 'VALIDATION_SMTP_HOST_REJECTED' });
    });

    it('private hosts are allowed only outside production AND with the explicit dev switch', async () => {
      process.env.SMTP_ALLOW_PRIVATE_HOSTS = 'true';
      await expect(resolveSafeSmtpHost('127.0.0.1')).resolves.toMatchObject({ address: '127.0.0.1' });
      const env = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await expect(resolveSafeSmtpHost('127.0.0.1')).rejects.toMatchObject({ code: 'VALIDATION_SMTP_HOST_REJECTED' });
      } finally {
        process.env.NODE_ENV = env;
      }
    });
  });

  describe('ports', () => {
    it.each([25, 465, 587, 2525, '587'])('allows %s', (port) => {
      expect(() => assertAllowedPort(port)).not.toThrow();
    });
    it.each([22, 80, 443, 3306, 6379, 0, 99999, 'abc'])('refuses %s', (port) => {
      expect(() => assertAllowedPort(port)).toThrow();
    });
  });

  describe('header safety', () => {
    it('strips CR/LF, quotes and angle brackets from a display name', () => {
      const name = sanitizeDisplayName('Grand "Hotel"\r\nBcc: victim@example.com <x@y.z>');
      expect(name).not.toMatch(/[\r\n"<>]/);
      expect(name).toBe('Grand Hotel Bcc: victim@example.com x@y.z');
    });
    it('falls back when nothing safe is left, and caps the length', () => {
      expect(sanitizeDisplayName('"\r\n"')).toBe('LodgeKeep');
      expect(sanitizeDisplayName('a'.repeat(500)).length).toBe(80);
    });
    it.each(['a@b.com', 'first.last+tag@sub.example.co.uk'])('accepts %s as a single address', (v) => {
      expect(isSingleEmailAddress(v)).toBe(true);
    });
    it.each([
      'a@b.com\r\nBcc: x@y.com', 'a@b.com, c@d.com', 'a@b.com;c@d.com', 'Name <a@b.com>', ' a@b.com', 'a@b', 'a b@c.com',
      '', null, undefined, 'a@b.com ',
    ])('rejects %j', (v) => {
      expect(isSingleEmailAddress(v)).toBe(false);
    });
  });

  describe('scrubSecrets', () => {
    it('removes the password, URL credentials and key=value secrets', () => {
      const text = scrubSecrets('535 auth failed for u@x.com password=hunter22 via smtp://u:hunter22@mail.x.com', ['hunter22']);
      expect(text).not.toContain('hunter22');
    });
    it('caps the length', () => {
      expect(scrubSecrets('x'.repeat(1000)).length).toBeLessThanOrEqual(300);
    });
  });
});

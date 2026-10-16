'use strict';

/**
 * F-12 (product audit): the door-access import parsed the WHOLE uploaded workbook before any row limit applied, and a
 * 20 MiB upload could expand (a zip bomb) into far more memory on the single process that serves every tenant. Now:
 * the upload has a hard size cap, the parser stops reading after the row cap, wide sheets and workbooks that unzip to
 * far more than the cap are refused, and each refusal is a clear 400 `VALIDATION_DOOR_ACCESS_FILE_TOO_LARGE`
 * (never a 500, never a raw multer error), on all three import routes.
 */

const XLSX = require('xlsx');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

const MAPPING = { roomColumn: 'Door', cardColumn: 'Card', timestampColumn: 'Time', timestampFormat: 'YYYY-MM-DD HH:mm:ss' };
const ROUTES = ['headers', 'preview', 'commit'];

describe('F-12: door-access import size and shape limits', () => {
  const t = useTestApp();
  const ORIGINAL_ENV = { ...process.env };
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
  });

  const manager = () => signAccessToken({ aud: 'staff', sub: String(ctx.a.users[0].id), tenant_id: String(ctx.a.id), property_id: String(ctx.a.properties[0].id) });
  const upload = (route, buffer, filename = 'audit.csv') => t.request.post(`/api/v1/door-access/imports/${route}`).set('Authorization', `Bearer ${manager()}`).field('mapping', JSON.stringify(MAPPING)).attach('file', buffer, filename);

  const csvWithRows = (n) => Buffer.from(['Door,Card,Time', ...Array.from({ length: n }, (_, i) => `${100 + (i % 50)},C${i},2027-01-01 10:00:00`)].join('\n'));
  const xlsxWithRows = (n) => {
    const rows = [['Door', 'Card', 'Time'], ...Array.from({ length: n }, (_, i) => [100 + (i % 50), `C${i}`, '2027-01-01 10:00:00'])];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Log');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  };
  const expectTooLarge = (res) => {
    expect({ status: res.status, code: res.body.error?.code }).toEqual({ status: 400, code: 'VALIDATION_DOOR_ACCESS_FILE_TOO_LARGE' });
  };

  describe.each(ROUTES)('POST /door-access/imports/%s', (route) => {
    it('refuses a file over the upload size cap with a clear 400 (not a raw multer error)', async () => {
      expectTooLarge(await upload(route, Buffer.alloc(11 * 1024 * 1024, 'a')));
    });

    it('refuses a sheet with more rows than the row cap', async () => {
      expectTooLarge(await upload(route, csvWithRows(50001)));
    });

    it('refuses a sheet with too many columns', async () => {
      const header = Array.from({ length: 300 }, (_, i) => `H${i}`).join(',');
      expectTooLarge(await upload(route, Buffer.from(`${header}\n${header}`)));
    });

    it('refuses a workbook that unzips to far more than the unzipped-size cap', async () => {
      process.env.DOOR_ACCESS_MAX_UNZIPPED_BYTES = '50000';
      expectTooLarge(await upload(route, xlsxWithRows(3000), 'bomb.xlsx'));
    });
  });

  it('a modest workbook still imports, and the unzipped-size cap ignores a garbage setting', async () => {
    process.env.DOOR_ACCESS_MAX_UNZIPPED_BYTES = 'lots';
    const res = await upload('headers', xlsxWithRows(50), 'ok.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data.headers).toEqual(['Door', 'Card', 'Time']);
  });

  it('a file at the row cap is still accepted', async () => {
    const res = await upload('headers', csvWithRows(50000));
    expect(res.status).toBe(200);
  });

  it('asks the spreadsheet reader to stop after the row cap instead of parsing the whole workbook', async () => {
    const spy = jest.spyOn(XLSX, 'read');
    await upload('headers', csvWithRows(10));
    expect(spy).toHaveBeenCalled();
    const options = spy.mock.calls[0][1];
    expect(options.sheetRows).toBeGreaterThan(50000);
    expect(options.sheetRows).toBeLessThanOrEqual(50003);
  });

  it('a truncated or corrupted xlsx is a clear 400, not a crash', async () => {
    const good = xlsxWithRows(20);
    for (const bad of [good.subarray(0, Math.floor(good.length / 2)), Buffer.concat([good.subarray(0, 30), Buffer.alloc(200, 0xff)])]) {
      const res = await upload('headers', bad, 'broken.xlsx');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toMatch(/^VALIDATION_DOOR_ACCESS_FILE_/);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { decimalToString, lineAmounts, normalizeDecimalString, parseDecimalString, roundHalfUp } from './decimal.js';

describe('parseDecimalString', () => {
    it('parses canonical and Czech-shaped decimal strings', () => {
        expect(parseDecimalString('1234.56')).toBe(1234.56);
        expect(parseDecimalString('1 234,56')).toBe(1234.56);
        expect(parseDecimalString('1\u00a0234,56')).toBe(1234.56);
        expect(parseDecimalString('1\u202f234,56')).toBe(1234.56);
        expect(parseDecimalString('1.234,56')).toBe(1234.56);
        expect(parseDecimalString('1,234.56')).toBe(1234.56);
        expect(parseDecimalString('0.03')).toBe(0.03);
        expect(parseDecimalString('21')).toBe(21);
        expect(parseDecimalString('-7.5')).toBe(-7.5);
    });

    it('rejects empty, malformed, and multi-separator input', () => {
        expect(parseDecimalString('')).toBeNull();
        expect(parseDecimalString('   ')).toBeNull();
        expect(parseDecimalString('abc')).toBeNull();
        expect(parseDecimalString('1,23,4')).toBeNull();
        expect(parseDecimalString(null)).toBeNull();
        expect(parseDecimalString(undefined)).toBeNull();
    });
});

describe('roundHalfUp', () => {
    it('rounds half away from zero despite floating point noise', () => {
        expect(roundHalfUp(1.005)).toBe(1.01);
        expect(roundHalfUp(2.675)).toBe(2.68);
        expect(roundHalfUp(-1.005)).toBe(-1.01);
        expect(roundHalfUp(0.0126)).toBe(0.01);
        expect(roundHalfUp(1.004)).toBe(1);
    });
});

describe('lineAmounts', () => {
    it('rounds each line independently per the generation contract', () => {
        expect(lineAmounts({ quantity: '1', unitPrice: '0.03', vatRate: '21' }))
            .toEqual({ net: 0.03, vat: 0.01, gross: 0.04 });
        expect(lineAmounts({ quantity: '2.5', unitPrice: '100', vatRate: '12' }))
            .toEqual({ net: 250, vat: 30, gross: 280 });
        expect(lineAmounts({ quantity: '1', unitPrice: '100', vatRate: '0' }))
            .toEqual({ net: 100, vat: 0, gross: 100 });
    });

    it('returns null when any component is unparseable', () => {
        expect(lineAmounts({ quantity: 'abc', unitPrice: '1', vatRate: '21' })).toBeNull();
        expect(lineAmounts({ quantity: '1', unitPrice: '', vatRate: '21' })).toBeNull();
        expect(lineAmounts({ quantity: '1', unitPrice: '1', vatRate: '?' })).toBeNull();
    });

    it('prefers supplier-declared line amounts over recomputation', () => {
        // 216.60 × 21% = 45.486; Alza declares 45.48 and must win.
        expect(lineAmounts({
            quantity: '1.0000',
            unitPrice: '216.6000',
            vatRate: '21.0000',
            netAmount: '216.60',
            vatAmount: '45.48',
        })).toEqual({ net: 216.6, vat: 45.48, gross: 262.08 });
    });
});

describe('normalizeDecimalString', () => {
    it('canonicalizes money to two decimals and preserves unparseable text', () => {
        expect(normalizeDecimalString('262.0800')).toBe('262.08');
        expect(normalizeDecimalString('216,6000')).toBe('216.60');
        expect(normalizeDecimalString('')).toBe('');
        expect(normalizeDecimalString('not a number')).toBe('not a number');
    });
});

describe('decimalToString', () => {
    it('formats with a fixed scale', () => {
        expect(decimalToString(1.5)).toBe('1.50');
        expect(decimalToString(0)).toBe('0.00');
        expect(decimalToString(Number.NaN)).toBe('');
    });
});

import { describe, it, expect } from 'vitest'
import { parseSeed } from '../src/utils/seed'

describe('parseSeed（开局页种子输入）', () => {
  it('"0" 是合法种子，不会变成随机', () => {
    expect(parseSeed('0')).toBe(0)
    expect(parseSeed(' 0 ')).toBe(0)
    expect(parseSeed('0.9')).toBe(0)
    expect(parseSeed('-0')).toBe(0)
  })
  it('空串 / 非数字 → undefined（随机）', () => {
    expect(parseSeed('')).toBeUndefined()
    expect(parseSeed('   ')).toBeUndefined()
    expect(parseSeed('abc')).toBeUndefined()
    expect(parseSeed('Infinity')).toBeUndefined()
  })
  it('正常数字：取整、取绝对值、折成 32 位', () => {
    expect(parseSeed('42')).toBe(42)
    expect(parseSeed('-7')).toBe(7)
    expect(parseSeed('3.8')).toBe(3)
    expect(parseSeed('4294967296')).toBe(0)
    expect(parseSeed('4294967297')).toBe(1)
  })
})

import { describe, it, expect } from "vitest";
import { compileCondition } from "../condition.js";

describe("compileCondition", () => {
  it("evaluates dot-path equality", () => {
    const fn = compileCondition("nodes.a.result.ok === true");
    expect(fn({ nodes: { a: { result: { ok: true } } } })).toBe(true);
    expect(fn({ nodes: { a: { result: { ok: false } } } })).toBe(false);
  });

  it("evaluates inequality", () => {
    const fn = compileCondition("nodes.a.status !== 'failed'");
    expect(fn({ nodes: { a: { status: "completed" } } })).toBe(true);
    expect(fn({ nodes: { a: { status: "failed" } } })).toBe(false);
  });

  it("evaluates logical AND", () => {
    const fn = compileCondition("nodes.a.status === 'completed' && nodes.b.status === 'completed'");
    expect(fn({ nodes: { a: { status: "completed" }, b: { status: "completed" } } })).toBe(true);
    expect(fn({ nodes: { a: { status: "completed" }, b: { status: "failed" } } })).toBe(false);
  });

  it("evaluates logical OR", () => {
    const fn = compileCondition("nodes.a.status === 'completed' || nodes.b.status === 'completed'");
    expect(fn({ nodes: { a: { status: "failed" }, b: { status: "completed" } } })).toBe(true);
    expect(fn({ nodes: { a: { status: "failed" }, b: { status: "failed" } } })).toBe(false);
  });

  it("evaluates negation", () => {
    const fn = compileCondition("!nodes.a.result.skip");
    expect(fn({ nodes: { a: { result: { skip: false } } } })).toBe(true);
    expect(fn({ nodes: { a: { result: { skip: true } } } })).toBe(false);
  });

  it("handles parentheses", () => {
    const fn = compileCondition("(nodes.a.status === 'completed') && (!nodes.b.result.skip)");
    expect(fn({ nodes: { a: { status: "completed" }, b: { result: { skip: false } } } })).toBe(true);
  });

  it("handles numeric literals", () => {
    const fn = compileCondition("nodes.a.result.count === 42");
    expect(fn({ nodes: { a: { result: { count: 42 } } } })).toBe(true);
    expect(fn({ nodes: { a: { result: { count: 0 } } } })).toBe(false);
  });

  it("handles null/undefined comparisons", () => {
    const fn = compileCondition("nodes.a.result !== null");
    expect(fn({ nodes: { a: { result: { ok: true } } } })).toBe(true);
    expect(fn({ nodes: { a: { result: null } } })).toBe(false);
  });

  it("returns false for missing paths (truthy check)", () => {
    const fn = compileCondition("nodes.missing.result.ok === true");
    expect(fn({ nodes: {} })).toBe(false);
  });

  it("rejects invalid expressions", () => {
    expect(() => compileCondition("process.exit(1)")).toThrow();
    expect(() => compileCondition("require('fs')")).toThrow();
  });
});

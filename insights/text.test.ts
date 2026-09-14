import { describe, expect, it } from "vitest";
import { countWords, editDistance, fillerCount, tokenize, topWords, wordEdits } from "./text";

describe("tokenize / countWords", () => {
  it("splits on non-word characters, keeps inner apostrophes, lower-cases", () => {
    expect(tokenize("Don't stop — it's 10 AM!")).toEqual(["don't", "stop", "it's", "10", "am"]);
    expect(countWords("Hello,   world.")).toBe(2);
    expect(countWords("")).toBe(0);
  });
  it("counts Devanagari words", () => {
    expect(countWords("मुझे कल सुबह दस बजे मीटिंग है।")).toBe(7);
  });
});

describe("fillerCount", () => {
  it("counts filler tokens only", () => {
    expect(fillerCount("um so uh basically hmm we should um go")).toBe(4);
    expect(fillerCount("like this is fine")).toBe(0);
  });
});

describe("editDistance / wordEdits", () => {
  it("is the token Levenshtein distance", () => {
    expect(editDistance(["a", "b", "c"], ["a", "b", "c"])).toBe(0);
    expect(editDistance(["a", "b", "c"], ["a", "c"])).toBe(1);
    expect(editDistance(["a", "b"], ["a", "x", "b", "y"])).toBe(2);
    expect(editDistance([], ["a"])).toBe(1);
  });
  it("ignores case and punctuation when comparing raw to polished", () => {
    expect(wordEdits("um so we should refactor the the user service", "So we should refactor the user service.")).toBe(2);
    expect(wordEdits("hello world", "Hello, world!")).toBe(0);
  });
});

describe("topWords", () => {
  it("ranks non-stopword, non-filler tokens of 3+ letters", () => {
    const top = topWords(["deploy the deploy um deploy", "the bug and the deploy"], 2);
    expect(top).toEqual([
      { word: "deploy", count: 4 },
      { word: "bug", count: 1 },
    ]);
  });
});

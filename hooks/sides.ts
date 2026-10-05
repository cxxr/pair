/**
 * Whether a path is a test, going by its name and folders: `test_heap.py`,
 * `heap_test.go`, `heap.spec.ts`, or anything under `tests/`.
 */
export const isTestFile = (path: string): boolean =>
  /(^|[/._-])(tests?|specs?)([/._-]|$)/i.test(path)

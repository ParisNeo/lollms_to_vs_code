declare module 'fnmatch' {
  /**
   * Tests whether a string matches a glob pattern.
   * @param pattern The glob pattern.
   * @param str The string to test.
   * @param options Optional settings.
   */
  function fnmatch(pattern: string, str: string, options?: object): boolean;
  export = fnmatch;
}
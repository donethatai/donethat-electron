// Jest environment that runs a test file in the timezone named by its
// `@timezone` docblock pragma, e.g.
//
//   /**
//    * @jest-environment ./src-main/__tests__/timezone-environment.js
//    * @timezone America/New_York
//    */
//
// Tests see a sandboxed copy of process.env, so setting TZ inside a test never
// reaches the worker. The environment runs in the worker itself, sets the real
// TZ before the file's tests and restores it after, since workers are reused.
const { TestEnvironment } = require('jest-environment-node');

class TimezoneEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    this.timezone = context.docblockPragmas.timezone;
    if (typeof this.timezone !== 'string' || !this.timezone) {
      throw new Error(`${context.testPath}: timezone-environment needs a @timezone pragma`);
    }
  }

  async setup() {
    await super.setup();
    this.previousTimezone = process.env.TZ;
    process.env.TZ = this.timezone;
  }

  async teardown() {
    if (this.previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = this.previousTimezone;
    }
    await super.teardown();
  }
}

module.exports = TimezoneEnvironment;

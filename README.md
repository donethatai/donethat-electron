# ✓ Done That

Remembering your work for you.

## Development

### Signing and notarizing

MACOS:
* Set all the variables in the .env-template file as .env
* See https://kilianvalkhof.com/2019/electron/notarizing-your-electron-application/
* Download xcode, sign in with dev account, go to settings>accounts, manage certificates, add all certificates

WINDOWS:
* TODO
* Download [java](https://www.java.com/en/download/) and [jsign](https://github.com/jpackage-dev/jsign)
* Run `npm run release`

### Releases

* Generate a release token on GitHub
* Set it with `export GH_TOKEN=your_generated_token`
* Run `npm run release`

### Development

* Run `npm run start` to start the development server

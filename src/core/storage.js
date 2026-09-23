// Shared Documents/aerox-tas directory, so macros, warp logs and anything else
// land in one place you can pull off the device.

const log = require('./log');
const mem = require('./mem');

function documentsPath() {
    try {
        const urls = ObjC.classes.NSFileManager.defaultManager()
            .URLsForDirectory_inDomains_(9 /* NSDocumentDirectory */, 1 /* NSUserDomainMask */);
        if (urls !== null && urls.count() > 0) {
            return urls.objectAtIndex_(0).path().toString();
        }
    } catch (err) {
        log.error('storage.documentsPath', err);
    }
    return null;
}

function directory() {
    const docs = documentsPath();
    if (docs === null) return null;
    const dir = `${docs}/aerox-tas`;
    try {
        ObjC.classes.NSFileManager.defaultManager()
            .createDirectoryAtPath_withIntermediateDirectories_attributes_error_(
                dir, true, NULL, NULL);
    } catch (err) {
        log.error('storage.directory', err);
        return null;
    }
    return dir;
}

function writeJson(fileName, value) {
    const dir = directory();
    if (dir === null) return false;
    try {
        // Pool: warp logs save from the probe timer, off the main run loop.
        // Without it every save's NSString (the whole hit list) leaked.
        return mem.withPool(function () {
            const ok = ObjC.classes.NSString.stringWithString_(JSON.stringify(value))
                .writeToFile_atomically_encoding_error_(
                    `${dir}/${fileName}`, true, 4 /* NSUTF8 */, NULL);
            return !!ok;
        });
    } catch (err) {
        log.error(`storage.writeJson ${fileName}`, err);
        return false;
    }
}

function readJson(fileName) {
    const dir = directory();
    if (dir === null) return null;
    try {
        return mem.withPool(function () {
            const s = ObjC.classes.NSString.stringWithContentsOfFile_encoding_error_(
                `${dir}/${fileName}`, 4, NULL);
            if (s === null) return null;
            return JSON.parse(s.toString());
        });
    } catch (err) {
        log.error(`storage.readJson ${fileName}`, err);
        return null;
    }
}

module.exports = { documentsPath, directory, writeJson, readJson };

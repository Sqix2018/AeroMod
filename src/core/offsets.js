// Every version-specific address lives here and nowhere else.
//
// Adding support for another Aerox build means adding one entry below, not
// touching any other file. Offsets are relative to the Aerox module base.
//
// Derived from static analysis of 1.9.5 (com.synoptical.aerox, arm64).

// btRigidBody is 0x310 bytes and matches stock Bullet; these hold across builds.
const RIGID_BODY = {
    worldTransform: 0x10,          // btTransform, origin at +0x40
    origin: 0x40,
    interpolationTransform: 0x50,  // origin at +0x80
    interpolationOrigin: 0x80,
    collisionFlags: 0xe8,
    activationState: 0xf8,
    deactivationTime: 0xfc,
    friction: 0x100,
    userPointer: 0x120,            // back-pointer to the owning synNode
    broadphaseHandle: 0xc8,        // btBroadphaseProxy*; AABB lives on the proxy
    updateRevision: 0x160,
    linearVelocity: 0x1b0,
    angularVelocity: 0x1c0,
    inverseMass: 0x1d0,
    linearFactor: 0x1e0,
    totalForce: 0x220,
    totalTorque: 0x230,
    motionState: 0x268,            // btDefaultMotionState, graphics transform at +0x10
};

// btBroadphaseProxy / btDbvtProxy, relative to the handle pointer.
const BROADPHASE_PROXY = {
    clientObject: 0x00,
    aabbMin: 0x20,
    aabbMax: 0x30,
    leaf: 0x40,                    // btDbvtNode*; volume is two btVector3s at 0
};

// btTransform: btMatrix3x3 (48 bytes) then the origin btVector3.
const TRANSFORM = { origin: 0x30, size: 0x40 };

const VERSIONS = {
    '1.9.5': {
        globals: {
            scene: 0x2ff950,          // synScene*, NULL between levels
            physics: 0x2ff940,        // synPhysics*, owns the Bullet dynamics world
            essentials: 0x2ff958,     // synScene* Essentials.scn (ResetPlayer), loaded once
            ball: 0x2ff978,           // synModel*, written only by loadLevel:
            ballArray: 0x2ff970,      // synModel**, selectable skins
            ballIndex: 0x2ffb44,      // int32
            ballCount: 0x2f2c30,      // int32

            lastFrameTime: 0x2ff918,  // double, NSDate epoch; dt = now - this
            runTimer: 0x2ffb90,       // float, accumulates dt, saved as LevelTime_%d
            cameraYaw: 0x2ffb84,      // float, wrapped to [0, 2pi)

            tiltSteer: 0x2ffb48,      // float, from accelY - calibY
            tiltThrust: 0x2ffb4c,     // float, from calibX - accelX, normalized
            tiltZ: 0x2ffb50,          // float, from accelZ - calibZ
            buttonA: 0x2ffb81,        // byte, on-screen button (touchesBegan/Ended)
            buttonB: 0x2ffb80,        // byte, on-screen button

            calibration: 0x2ffa80,    // 3 floats: calibX, calibY, calibZ
            motionManager: 0x2ffbb0,  // CMMotionManager*; NULL selects accelerometer path
            motionReference: 0x2ffbb8, // CMAttitude*, alt-controls reference frame

            levelNumber: 0x2f2c24,    // int32, the level startGame: is about to run
            inPlay: 0x2ffb99,         // byte, controls live

            // Set while a blocking on-screen message is up: the "Get Ready!"
            // prompt, a TextTrigger tip, or the tutorial blurb. touchesBegan:
            // clears it, and the run timer does not advance while it is set.
            menuFlag: 0x2ffb95,

            inLevel: 0x2ffb96,        // byte, set by loadLevel:, cleared by unloadLevel
            mainMenu: 0x2ffba0,       // byte, the menuManager owns touches
            started: 0x2ffb8c,        // byte, StartPoint has fired once this level

            // The opening camera fly-around. Set by loadLevel:, cleared either
            // by the animation finishing or by touchesEnded: skipping it. The
            // level simulates while this plays, so moving platforms are already
            // in motion and *when* you skip decides the state you start from.
            introPlaying: 0x2ffba2,
            introTimer: 0x2ffba8,     // float, must exceed 0 before a skip is accepted

            readyPrompt: 0x2ffb9a,    // byte, the pending dismiss runs menu action -4
            messageId: 0x2ffbac,      // int32, which message the text model is showing
            textModel: 0x2ffa38,      // synModel*, the on-screen message quad
            flashModel: 0x2ffa50,     // synModel*, the fullscreen flash used on skip
            skyRtt: 0x2ffa70,         // synRTT*, live sky; glTextureNum stamped on HeroBall SkyDome
            checkpointYaw: 0x2ffb88,  // float, yaw restored by a respawn
            flashState: 0x2ffa90,     // byte, 1 = finish/respawn flash, 2 = death flash

            // Set only by the EndFlare branch of the collision filter, cleared
            // only by loadLevel:. Once set, processGameFrame skips all gameplay
            // and runs the victory camera - this is "level complete".
            levelComplete: 0x2ffb97,

            // float 14.0. Clamps angular velocity, caps linear speed, and scales
            // the steering falloff. Identical in both control modes.
            speedCap: 0x2f2c38,
        },
        functions: {
            setActivationState: 0x65ff4,  // void(btRigidBody*, int)
            // void(btDbvt*, int passes); rotates by comparing node addresses
            dbvtOptimizeIncremental: 0x460f0,
        },
        // GOT slots in the Aerox binary. Each is a pointer to the real GL fn.
        glImports: {
            glActiveTexture: 0x27ce90,
            glBindTexture: 0x27ceb8,
            glGenTextures: 0x27cfb8,
            glGetError: 0x27cfc8,
            glMatrixMode: 0x27d030,
            glScalef: 0x27d090,
            glTexImage2D: 0x27d0b8,
            glTexParameteri: 0x27d0c0,
            glPixelStorei: 0x27d050,
        },
        // Fallbacks only; resolved through the ObjC runtime at startup.
        ivars: {
            synNode: { worldTransform: 0x38, rigidBody: 0xe8, mass: 0xf0 },
            EAGLView: { accelX: 0x368, accelY: 0x36c, accelZ: 0x370 },
        },
    },
};

function bundleVersion() {
    try {
        const info = ObjC.classes.NSBundle.mainBundle().infoDictionary();
        const v = info.objectForKey_('CFBundleShortVersionString');
        return v === null ? null : v.toString();
    } catch (err) {
        return null;
    }
}

function resolve() {
    const version = bundleVersion();
    if (version !== null && VERSIONS[version] !== undefined) {
        return { version, layout: VERSIONS[version], exact: true };
    }

    // Unknown build: fall back to the newest table we have so the tool still
    // loads, but make it loud that the addresses are unverified.
    const fallback = Object.keys(VERSIONS).sort().pop();
    return { version: version || 'unknown', layout: VERSIONS[fallback], exact: false, fallback };
}

module.exports = { VERSIONS, RIGID_BODY, TRANSFORM, BROADPHASE_PROXY, resolve, bundleVersion };

importScripts(
    "../../../../build/three.js",
    "XRayRuntime.js",
    "XRayKernel.js"
    // "XRayCore.js"
);
var XRAY = XRAY || {};

addEventListener('message', onMessageReceived.bind(this), false);

var id;
var flags;
var pixelMemory;
var sampleMemory;
var camera;
var scene;
var sampler;
var imageWidth;
var imageHeight;
var width;
var height;
var xoffset;
var yoffset;
var samples;
var _cameraSamples;
var _absCameraSamples;
var _hitSamples;
var bounces;
var iterations = 1;
var locked;
var isLeader;

var IDLE = 0;
var TRACING = 1;
var TRACED = 2;
var LOCKING = 3;
var LOCKED = 4;

function onMessageReceived(e) {

    var data = e.data;

    switch (data.command) {

        case "INIT":

            id = e.data.id;
            isLeader = id == 0;

            flags = new Uint8Array(e.data.flagsBuffer);
            pixelMemory = new Uint8ClampedArray(e.data.pixelBuffer);
            sampleMemory = new Float32Array(e.data.sampleBuffer);

            let RAW_MEMORY = e.data.turboBuffer;
            unsafe.init(RAW_MEMORY, 0, RAW_MEMORY.byteLength, false);
            unsafe.RAW_MEMORY = RAW_MEMORY;
            Initialize_XRayKernel(XRAY);

            if (!camera) {
                camera = e.data.camera;
            }

            if (!scene) {
                scene = e.data.scene;

                if (isLeader) {
                    console.time("Scene compiled");
                    XRAY.Scene.Compile(scene);
                    console.timeEnd("Scene compiled");
                }
            }

            imageWidth = e.data.imageWidth;
            imageHeight = e.data.imageHeight;
            _cameraSamples = e.data.cameraSamples;
            _hitSamples = e.data.hitSamples;
            bounces = e.data.bounces;

            sampler = XRAY.NewSampler(_hitSamples, bounces);

            postMessage("INITIALIZED");

            break;

        case "UPDATE":

            imageWidth = e.data.width || imageWidth;
            imageHeight = e.data.height || imageHeight;

            if(e.data.scene){
                scene = e.data.scene;
                if (isLeader) {
                    console.time("Scene re-compiled");
                    XRAY.Scene.Compile(scene);
                    console.timeEnd("Scene re-compiled");
                }
            }

            postMessage("UPDATED");

            break;

        case "TRACE":

            if (Atomics.load(flags, id) === LOCKING) {//thread locked
                //console.log("exit:1");
                lock();
                return;
            }

            _cameraSamples = e.data.cameraSamples || _cameraSamples;
            _hitSamples = e.data.hitSamples || _hitSamples;

            width = e.data.width;
            height = e.data.height;
            xoffset = e.data.xoffset;
            yoffset = e.data.yoffset;
            _absCameraSamples = Math.round(Math.abs(_cameraSamples));

            if (e.data.camera) {
                // camera.updateFromJson(e.data.camera);
                ////console.log(e.data.camera);
            }

            iterations = e.data.init_iterations || 0;

            if (locked) {
                //console.log("restarted:" + iterations, "samples:" + checkSamples());
                locked = false;
            }

            if (iterations > 0 && e.data.blockIterations) {
                for (var i = 0; i < e.data.blockIterations; i++) {
                    if (Atomics.load(flags, id) === LOCKING) {//thread locked
                        lock();
                        return;
                    }
                    run();
                }
            } else {
                if (Atomics.load(flags, id) === LOCKING) {//thread locked
                    lock();
                    return;
                }
                run();
            }
            if (Atomics.load(flags, id) === LOCKING) {//thread locked
                lock();
                return;
            }
            postMessage("TRACED");
            break;

        case "LOCK":
            if (!locked) {
                locked = true;
            }
            postMessage("LOCKED");
            break;
    }

}

function lock() {
    if (!locked) {
        locked = true;
        postMessage("LOCKED");
    }
}

function run() {

    iterations++;
    var hitSamples = _hitSamples;
    var cameraSamples = _cameraSamples;
    var absCameraSamples = _absCameraSamples;
    if (iterations == 1) {
        hitSamples = 1;
        cameraSamples = -1;
        absCameraSamples = Math.round(Math.abs(cameraSamples));
    }

    ////console.time("render");
    for (var y = yoffset; y < yoffset + height; y++) {

        for (var x = xoffset; x < xoffset + width; x++) {

            if (Atomics.load(flags, id) === LOCKING) {//thread locked
                //console.log("exit:3");
                lock();
                return;
            }

            var screen_index = (y * (imageWidth * 3)) + (x * 3);
            // var _x = x - xoffset;
            // var _y = y - yoffset;

            var c = new XRAY.Color3();

            if (cameraSamples <= 0) {
                // random subsampling
                for (let i = 0; i < absCameraSamples; i++) {
                    var fu = Math.random();
                    var fv = Math.random();
                    let ray = XRAY.Camera.CastRay(camera, x, y, imageWidth, imageHeight, fu, fv);
                    let sample = sampler.sample(scene, ray, true, hitSamples, 1);
                    c = c.add(sample);
                }
                c = c.divScalar(absCameraSamples);
            } else {
                // stratified subsampling
                var n = Math.round(Math.sqrt(cameraSamples));
                for (var u = 0; u < n; u++) {
                    for (var v = 0; v < n; v++) {
                        var fu = (u + 0.5) / n;
                        var fv = (v + 0.5) / n;
                        let ray = XRAY.Camera.CastRay(camera, x, y, imageWidth, imageHeight, fu, fv);
                        let sample = sampler.sample(scene, ray, true, hitSamples, 1);
                        c = c.add(sample);
                    }
                }
                c = c.divScalar(n * n);
            }

            if (Atomics.load(flags, id) === LOCKING) {//thread locked
                //console.log("exit:7");
                lock();
                return;
            }

            c = c.pow(1 / 2.2);

            updatePixel(c, screen_index);
        }
    }
    ////console.timeEnd("render");
}

function updatePixel(color, si) {

    if (Atomics.load(flags, id) === LOCKING) {//thread locked
        //console.log("exit:8");
        lock();
        return;
    }
    sampleMemory[si] += color.r;
    sampleMemory[si + 1] += color.g;
    sampleMemory[si + 2] += color.b;

    pixelMemory[si] = Math.max(0, Math.min(255, (sampleMemory[si] / iterations) * 255));
    pixelMemory[si + 1] = Math.max(0, Math.min(255, (sampleMemory[si + 1] / iterations) * 255));
    pixelMemory[si + 2] = Math.max(0, Math.min(255, (sampleMemory[si + 2] / iterations) * 255));

}

function checkSamples() {
    for (var y = yoffset; y < yoffset + height; y++) {
        for (var x = xoffset; x < xoffset + width; x++) {
            var si = (y * (imageWidth * 3)) + (x * 3);
            if (sampleMemory[si] !== 0 &&
                sampleMemory[si + 1] !== 0 &&
                sampleMemory[si + 2] !== 0) {
                return "NOT_OK";
            }
        }
    }
    return "OK";
}

function drawColor(i, rgba) {

    pixelMemory[i] = rgba.r;
    pixelMemory[i + 1] = rgba.g;
    pixelMemory[i + 2] = rgba.b;

}

function drawPixelInt(i, color) {

    var red = (color >> 16) & 255;
    var green = (color >> 8) & 255;
    var blue = color & 255;

    pixelMemory[i] = red;
    pixelMemory[i + 1] = green;
    pixelMemory[i + 2] = blue;
}
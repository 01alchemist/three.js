importScripts(
    "../../../../build/three.js",
    "XRayRuntime.js",
    "XRayKernel.js"
    // "XRayCore.js"
);
var XRAY = XRAY || {};

addEventListener('message', onMessageReceived.bind(this), false);

let id;
let flags;
let pixelMemory;
let sampleMemory;
let camera;
let scene;
let sampler;
let imageWidth;
let imageHeight;
let width;
let height;
let xoffset;
let yoffset;
let samples;
let _cameraSamples;
let _absCameraSamples;
let _hitSamples;
let bounces;
let iterations = 1;
let locked;
let isLeader;

let IDLE = 0;
let TRACING = 1;
let TRACED = 2;
let LOCKING = 3;
let LOCKED = 4;

function onMessageReceived(e) {

    let data = e.data;

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

            iterations = e.data.init_iterations || 0;

            if (locked) {
                //console.log("restarted:" + iterations, "samples:" + checkSamples());
                locked = false;
            }

            if (iterations > 0 && e.data.blockIterations) {
                for (let i = 0; i < e.data.blockIterations; i++) {
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
    let hitSamples = _hitSamples;
    let cameraSamples = _cameraSamples;
    let absCameraSamples = _absCameraSamples;
    if (iterations == 1) {
        hitSamples = 1;
        cameraSamples = -1;
        absCameraSamples = Math.round(Math.abs(cameraSamples));
    }

    ////console.time("render");
    for (let y = yoffset; y < yoffset + height; y++) {

        for (let x = xoffset; x < xoffset + width; x++) {

            if (Atomics.load(flags, id) === LOCKING) {//thread locked
                //console.log("exit:3");
                lock();
                return;
            }

            let screen_index = (y * (imageWidth * 3)) + (x * 3);
            // let _x = x - xoffset;
            // let _y = y - yoffset;

            let c = new XRAY.Color3();

            if (cameraSamples <= 0) {
                // random subsampling
                for (let i = 0; i < absCameraSamples; i++) {
                    let fu = Math.random();
                    let fv = Math.random();
                    let ray = XRAY.Camera.CastRay(camera, x, y, imageWidth, imageHeight, fu, fv);
                    let sample = sampler.sample(scene, ray, true, hitSamples, 1);
                    c = c.add(sample);
                }
                c = c.divScalar(absCameraSamples);
            } else {
                // stratified subsampling
                let n = Math.round(Math.sqrt(cameraSamples));
                for (let u = 0; u < n; u++) {
                    for (let v = 0; v < n; v++) {
                        let fu = (u + 0.5) / n;
                        let fv = (v + 0.5) / n;
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

    Atomics.store(flags, id, IDLE);

    color = null;
    delete color;
}
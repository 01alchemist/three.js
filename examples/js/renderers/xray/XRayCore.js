var XRAY = XRAY || {};
(function XRayCore(XRAY) {

    /**
     * Thread pool
     */
    let ThreadPool = {};
    ThreadPool.reservedThreads = 0;
    ThreadPool.overrideMaxThreads = 0;
    ThreadPool.pool = null;
    Object.defineProperty(ThreadPool, "maxThreads", {
        get: function () {
            return ThreadPool.overrideMaxThreads > 0 ?
                ThreadPool.overrideMaxThreads : typeof navigator["hardwareConcurrency"] !== "undefined" ?
                    navigator["hardwareConcurrency"] - ThreadPool.reservedThreads : 4;
        }
    });
    ThreadPool.getThreads = function () {
        console.info("Available Threads:" + ThreadPool.maxThreads);

        if (ThreadPool.pool) {
            return ThreadPool.pool;
        }
        let threads = [];
        for (let i = 0; i < ThreadPool.maxThreads; i++) {
            threads.push(new Thread("Thread:#" + i, i));
        }
        ThreadPool.pool = threads;
        return threads;
    };
    XRAY.ThreadPool = ThreadPool;

    /**
     * Thread
     */
    let Thread = function Thread(name, id) {
        this.initialized = false;
        this.name = name;
        this.id = id;
        let _isTracing = false;
        let instance;

        Object.defineProperty(this, "isTracing", {
            get: function () {
                return _isTracing;
            }
        });
        try {
            instance = new Worker(Thread.workerUrl);
        } catch (e) {
            console.log(e);
        }

        instance.onmessage = (event) => {
            if (event.data == TraceJob.INITIALIZED) {
                this.initialized = true;
                if (this.onInitComplete) {
                    this.onInitComplete(this);
                }
                _isTracing = false;
            }
            if (event.data == TraceJob.UPDATED) {
                if (this.onUpdateComplete) {
                    this.onUpdateComplete(this);
                }
            }
            if (event.data == TraceJob.TRACED) {
                Atomics.store(TraceManager.flags, this.id, Thread.IDLE);
                if (this.onTraceComplete) {
                    this.onTraceComplete(this);
                }
                _isTracing = false;
            }
            if (event.data == TraceJob.LOCKED) {
                Atomics.store(TraceManager.flags, this.id, Thread.LOCKED);
                if (this.onThreadLocked) {
                    this.onThreadLocked(this);
                }
                _isTracing = false;
            }
        };

        this.init = function (parameters, transferable, onInit) {
            // console.log("Initializing thread " + this.id);
            this.onInitComplete = onInit;
            parameters.command = TraceJob.INIT;
            parameters.id = this.id;
            this.send(parameters, transferable);
        };

        this.update = function (parameters, onUpdate) {
            this.onUpdateComplete = onUpdate;
            parameters.command = TraceJob.UPDATE;
            this.send(parameters);
        };

        this.trace = function (parameters, onComplete) {
            if (Atomics.load(TraceManager.flags, this.id) === Thread.LOCKING) {
                Atomics.store(TraceManager.flags, this.id, Thread.LOCKED);
                if (this.onThreadLocked) {
                    this.onThreadLocked(this);
                }
                _isTracing = false;
            }
            else {
                _isTracing = true;
                Atomics.store(TraceManager.flags, this.id, Thread.TRACING);
                this.onTraceComplete = onComplete;
                parameters.command = TraceJob.TRACE;
                this.send(parameters);
            }
        };

        this.send = function (data, buffers) {
            try{
                instance.postMessage(data);
            } catch (e) {
                instance.postMessage(data, buffers);
            }
        };

        this.terminate = function () {
            //this.onTraceComplete = null;
            //this.send(TraceJob.TERMINATE);
        }
    };
    Thread.workerUrl = "../examples/js/renderers/xray/XRayWorker.js";
    Thread.IDLE = 0;
    Thread.TRACING = 1;
    Thread.TRACED = 2;
    Thread.LOCKING = 3;
    Thread.LOCKED = 4;
    XRAY.Thread = Thread;

    /**
     * Trace job
     */
    let TraceJob = function TraceJob(renderOptions) {
        this.parameters = renderOptions;
        this.runCount = 0;
        let finished = false;
        let time = 0;

        Object.defineProperty(this, "time", {
            get: function () {
                return time;
            }
        });
        Object.defineProperty(this, "finished", {
            get: function () {
                return finished;
            }
        });

        this.start = function (thread, onComplete) {
            finished = false;
            let startTime = performance.now();
            let parameters = this.getTraceParameters();
            thread.trace(parameters, function (thread) {
                time = performance.now() - startTime;
                finished = true;
                if (onComplete) {
                    onComplete(this, thread);
                }
            }.bind(this));

            this.runCount++;
        };

        this.getTraceParameters = function () {

            let parameters = {init_iterations: 0};
            let extraCount = 0;
            for (let key in this.extra) {
                if (this.extra.hasOwnProperty(key)) {
                    parameters[key] = this.extra[key];
                    delete this.extra[key];
                    extraCount++;
                }
            }
            if (extraCount > 0) {
                for (let key in renderOptions) {
                    if (renderOptions.hasOwnProperty(key)) {
                        parameters[key] = renderOptions[key];
                    }
                }
            } else {
                parameters = renderOptions;
            }

            parameters.init_iterations = (this.runCount * renderOptions.blockIterations) - (this.runCount > 0 ? (renderOptions.blockIterations - 1) : 0);
            return parameters;
        }
    };
    TraceJob.INIT = "INIT";
    TraceJob.UPDATE = "UPDATE";
    TraceJob.UPDATED = "UPDATED";
    TraceJob.INITIALIZED = "INITIALIZED";
    TraceJob.TRACE = "TRACE";
    TraceJob.TRACED = "TRACED";
    TraceJob.TRACED = "TRACED";
    TraceJob.TERMINATE = "TERMINATE";
    TraceJob.LOCKED = "LOCKED";
    XRAY.TraceJob = TraceJob;

    /**
     * Trace manager
     */
    let TraceManager = function TraceManager() {

        let queue = [];
        let deferredQueue = [];
        let referenceQueue = [];
        let totalTime;
        let startTime;
        let width;
        let height;
        let flags;
        let traceParameters;
        let threads;
        let initCount = 0;
        let iterations = 1;
        let currentIterations = 0;
        let totalThreads = 0;
        let _initialized = false;
        let _isIterationFinished = true;
        let _isRenderingFinished = true;
        let _await;
        let deferredStart = false;
        let stopped = true;
        let lockCount = 0;
        let maxWidth = 1920;
        let maxHeight = 1080;

        Object.defineProperty(this, "initialized", {
            get: function () {
                return _initialized;
            }
        });

        this.configure = function (parameters) {

            width = parameters.width;
            height = parameters.height;
            iterations = parameters.iterations;

            flags = new Uint8Array(new SharedArrayBuffer(ThreadPool.maxThreads));
            TraceManager.flags = flags;
            this.pixelMemory = new Uint8ClampedArray(new SharedArrayBuffer(maxWidth * maxHeight * 3));
            this.sampleMemory = new Float32Array(new SharedArrayBuffer(4 * maxWidth * maxHeight * 3));

            traceParameters = {
                turboBuffer: unsafe.RAW_MEMORY,
                flagsBuffer: flags.buffer,
                sampleBuffer: this.sampleMemory.buffer,
                pixelBuffer: this.pixelMemory.buffer,
                scene: parameters.scene,
                camera: parameters.camera,
                cameraSamples: parameters.cameraSamples,
                hitSamples: parameters.hitSamples,
                bounces: parameters.bounces,
                imageWidth: width,
                imageHeight: height,
                webglWidth: parameters.webglWidth,
                webglHeight: parameters.webglHeight
            };
        };

        this.update = function (parameters) {
            if (this.updating) {
                return;
            }
            this.updating = true;
            if (!stopped) {
                this.stop();
            }

            this.clear();

            width = parameters.width || width;
            height = parameters.height || height;
            traceParameters.imageWidth = width;
            traceParameters.imageHeight = height;
            traceParameters.scene = parameters.scene || traceParameters.scene;

            if (threads) {
                let updateCount = 0;
                threads.forEach(function (thread) {
                    thread.update(parameters, function () {
                        updateCount++;
                        if (updateCount == totalThreads) {
                            this.restart();
                            this.updating = false;
                        }
                    }.bind(this));
                }.bind(this));
            }
        };

        this.clearJobs = function () {
            queue = [];
            referenceQueue = [];
        };
        this.add = function (job) {
            queue.push(job);
            referenceQueue.push(job);
        };

        this.init = function (callback) {
            console.log("Initializing threads...");
            console.time(ThreadPool.maxThreads + " Threads initialized");
            threads = ThreadPool.getThreads();
            totalThreads = threads.length;
            lockCount = threads.length;
            initNext(callback);
        };

        this.onThreadLockedCallback = null;
        let onThreadLocked = function () {
            lockCount++;
            if (this.isAllLocked) {
                if(this.onThreadLockedCallback){
                    this.onThreadLockedCallback();
                }
                if(deferredStart){
                    deferredStart = false;
                    this.clear();
                    this.restart();
                }
            }
        }.bind(this);

        let initNext = function initNext(callback) {

            if (initCount == totalThreads) {
                _initialized = true;
                console.timeEnd(ThreadPool.maxThreads + " Threads initialized");
                if (callback) {
                    callback();
                } else {
                    this.start();
                }
                return;
            }

            let thread = threads[initCount++];
            thread.onThreadLocked = onThreadLocked;
            thread.init(traceParameters, [
                traceParameters.flagsBuffer,
                traceParameters.pixelBuffer,
                traceParameters.sampleBuffer,
                traceParameters.turboBuffer
            ], function () {
                initNext(callback);
            });
        }.bind(this);

        Object.defineProperty(this, "isAllLocked", {
            get: function () {
                let thread;
                for (let i = 0; i < threads.length; i++) {
                    thread = threads[i];
                    // if (Atomics.load(flags, i) !== Thread.IDLE && Atomics.load(flags, i) !== Thread.LOCKED) {
                    if (Atomics.load(flags, i) !== Thread.LOCKED) {
                        return false;
                    }
                }
                return true;
            }
        });

        Object.defineProperty(this, "isAllThreadsFree", {
            get: function () {
                let thread;
                for (let i = 0; i < threads.length; i++) {
                    thread = threads[i];
                    if (thread.isTracing) {
                        // if (Atomics.load(flags, i) === Thread.TRACING || Atomics.load(flags, i) === Thread.LOCKING) {
                        //     return false;
                        // }
                        return false;
                    }

                }
                return true;
            }
        });

        Object.defineProperty(this, "isAllJobsDone", {
            get: function () {
                let job;
                let done = true;
                for (let i = 0; i < referenceQueue.length; i++) {
                    job = referenceQueue[i];
                    done = job.finished && done;
                }
                return done;
            }
        });

        this.lockAllThreads = function (callback) {
            this.onThreadLockedCallback = callback;
            for (let i = 0; i < threads.length; i++) {
                let thread = threads[i];
                if (thread.isTracing) {
                    Atomics.store(flags, i, Thread.LOCKING);
                } else {
                    Atomics.store(flags, i, Thread.IDLE);
                }
            }
            if(this.isAllThreadsFree && callback){
                callback();
            }
        };

        this.stop = function (callback) {

            if (flags) {
                queue = null;
                deferredQueue = null;
                deferredStart = false;
                this.lockAllThreads(callback);
                stopped = true;
                lockCount = 0;
                _await = true;
                let job;

                for (let i = 0; i < referenceQueue.length; i++) {
                    job = referenceQueue[i];
                    job.runCount = 0;
                }
            }
        };

        this.clear = function () {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    let si = (y * (width * 3)) + (x * 3);

                    this.pixelMemory[si] = 0;
                    this.pixelMemory[si + 1] = 0;
                    this.pixelMemory[si + 2] = 0;

                    this.sampleMemory[si] = 0;
                    this.sampleMemory[si + 1] = 0;
                    this.sampleMemory[si + 2] = 0;
                }
            }

            if (this.updatePixels) {
                this.updatePixels({
                        xoffset: 0,
                        yoffset: 0,
                        width: width,
                        height: height
                    },
                    this.pixelMemory
                );
            }
        };

        let resetTimerId = 0;

        this.restart = function () {
            if (!stopped) {
                this.stop();
            }
            currentIterations = 0;
            _isIterationFinished = false;
            if (flags && this.isAllThreadsFree) {
                if (_isRenderingFinished) {
                    console.log("Rendering restart pending");
                }
                queue = referenceQueue.concat();
                deferredQueue = [];
                _await = false;
                deferredStart = false;
                clearTimeout(resetTimerId);
                resetTimerId = setTimeout(this.start.bind(this), 100);
            } else {
                deferredStart = true;
            }
        };

        this.start = function () {
            if (currentIterations >= iterations || (queue && queue.length == 0 && deferredQueue.length === 0)) {
                if (!_isRenderingFinished) {
                    reportFinish();
                    _isRenderingFinished = true;
                }
                return;
            }
            //console.log("queue:" + queue.length);
            //console.time('trace::iteration completed');

            if (_initialized) {

                stopped = false;
                _isIterationFinished = false;

                if (_isRenderingFinished) {
                    console.log("Rendering started");
                    startTime = performance.now();
                    _isRenderingFinished = false;
                }

                let thread;
                let job;

                for (let i = 0; i < threads.length; i++) {
                    thread = threads[i];
                    if (queue && deferredQueue && queue.length > 0) {
                        job = queue.shift();
                        deferredQueue.push(job);
                        job.start(thread, function (_job, _thread) {
                            if (!_await) {
                                this.processQueue.call(this, _job, _thread);
                            }
                        }.bind(this));
                    } else {
                        break;
                    }
                }
            }
        };

        this.processQueue = function (job, thread) {
            if (this.updatePixels) {
                this.updatePixels(job.parameters, this.pixelMemory);
            }
            if (_isIterationFinished) {
                return;
            }

            if (queue.length > 0) {

                let job = queue.shift();
                deferredQueue.push(job);

                if (this.updateIndicator) {
                    this.updateIndicator(job.parameters);
                }

                job.start(thread, function (_job, _thread) {
                    if (!_await) {
                        this.processQueue.call(this, _job, _thread);
                    }
                }.bind(this));

            } else {
                if (this.isAllThreadsFree && this.isAllJobsDone) {
                    _isIterationFinished = true;
                    currentIterations++;
                    //console.timeEnd('trace::iteration completed');
                    setTimeout(this.initDeferredQueue.bind(this), 50);
                }
            }
        };

        this.initDeferredQueue = function () {

            if (currentIterations >= iterations ||
                ((queue && queue.length == 0) && (deferredQueue && deferredQueue.length === 0))) {
                if (!_isRenderingFinished) {
                    reportFinish();
                    _isRenderingFinished = true;
                }
                return;
            }

            _isIterationFinished = false;
            if(deferredQueue) {
                deferredQueue.sort(function (a, b) {
                    return b.time - a.time;
                });
                queue = deferredQueue;
            }

            deferredQueue = [];

            //console.time('trace::iteration completed');
            this.start();
        };

        function reportFinish(){
            totalTime = performance.now() - startTime;
            console.log(`Rendering finished (iterations: ${iterations}, time:${Math.round(totalTime/(1000))}s)`);
        }

    };
    XRAY.TraceManager = TraceManager;

    /**
     * XRay view
     */
    let XRayView = function XRayView(sceneColor) {
        this.camera = XRAY.Camera.LookAt(
            XRAY.Vector.NewVector(0, 10, 0),
            XRAY.Vector.NewVector(0, 0, 0),
            XRAY.Vector.NewVector(0, 0, 1),
            45
        );

        let resetMemoryOffset = Atomics.load(unsafe._mem_i32, 1);
        this.scene = new XRAY.MasterScene(sceneColor || 0);

        this.setScene = function (scene) {

            if (this.scene && this.scene.scenePtr) {

                unsafe.lock();
                let top = Atomics.load(unsafe._mem_i32, 1);

                for (let i = resetMemoryOffset; i < top; i++) {
                    Atomics.store(unsafe._mem_i32, i, 0);
                }

                Atomics.store(unsafe._mem_i32, 1, resetMemoryOffset);

                unsafe.unlock();
                this.scene.Clear();
            }

            this.scene.setClearColor(scene.background?scene.background.getHex():0);

            console.time("Scene builder");
            this.loadChildren(scene);
            this.scene.Commit();
            console.timeEnd("Scene builder");
        };

        this.updateCamera = function (camera, ratioX, ratioY, ratioZ) {
            if(typeof camera == "undefined"){
                return;
            }
            if (ratioX === void 0) {
                ratioX = 1;
            }
            if (ratioY === void 0) {
                ratioY = 1;
            }
            if (ratioZ === void 0) {
                ratioZ = 1;
            }
            let e = camera.matrix.elements;
            let x = {x: -e[0], y: -e[1], z: -e[2]};
            let y = {x: e[4], y: e[5], z: e[6]};
            let z = {x: -e[8], y: -e[9], z: -e[10]};

            let pos = {
                x: camera.position.x * ratioX,
                y: camera.position.y * ratioY,
                z: camera.position.z * ratioZ
            };

            XRAY.Camera.SetFromJSON(this.camera, {
                p: pos,
                u: x,
                v: y,
                w: z,
                m: 1 / Math.tan(camera.fov * Math.PI / 360)
            });

            this.dirty = true;
        };

        // Prepare three.js scene
        var identityMatrix = new THREE.Matrix4().identity();

        this.loadChildren = function (parent) {
            let child;
            for (let i = 0; i < parent.children.length; i++) {
                child = parent.children[i];

                let obj = buildSceneObject(child);
                if (obj) {
                    this.scene.Add(obj);
                }
                if (obj) {
                    if (!(XRAY.Material.IsLight(XRAY.Shape.MaterialAt(obj, XRAY.Vector.NewVector()))) && child.children.length > 0) {
                        this.loadChildren(child);
                    }
                } else {
                    if (child.children.length > 0) {
                        this.loadChildren(child);
                    }
                }
            }
        };

        function buildSceneObject(src) {

            switch (src.type) {
                case "Mesh":
                    let material = XRayView.getTurboMaterial(src.material);
                    let shape = buildTurboGeometry(src.geometry, material, src.smooth);

                    let matrixWorld = src.matrixWorld;

                    if (matrixWorld.equals(identityMatrix)) {
                        return shape;
                    } else {
                        let mat = XRAY.Matrix.fromTHREEJS(matrixWorld.elements);
                        let transShape = XRAY.TransformedShape.NewTransformedShape(shape, mat);
                        return transShape;
                    }

                case "PointLight":
                    return getTurboLight(src);

            }

            return null;
        }

        function buildTurboGeometry(geometry, material, smooth) {
            if (geometry["_bufferGeometry"]) {
                geometry = geometry["_bufferGeometry"];
            }

            let triangles = [];

            if (!geometry.attributes) {

                let vertices = geometry.vertices;
                let faces = geometry.faces;
                if (vertices && faces) {
                    for (let i = 0; i < faces.length; i++) {
                        let face = faces[i];
                        let t = XRAY.Triangle.initInstance(unsafe.alloc(53, 4));

                        unsafe._mem_i32[(t + 44) >> 2] = material;
                        unsafe._mem_i32[(t + 8) >> 2] = XRAY.Vector.NewVector(vertices[face.a].x, vertices[face.a].y, vertices[face.a].z);
                        unsafe._mem_i32[(t + 12) >> 2] = XRAY.Vector.NewVector(vertices[face.b].x, vertices[face.b].y, vertices[face.b].z);
                        unsafe._mem_i32[(t + 16) >> 2] = XRAY.Vector.NewVector(vertices[face.c].x, vertices[face.c].y, vertices[face.c].z);

                        unsafe._mem_i32[(t + 20) >> 2] = XRAY.Vector.NewVector(face.vertexNormals[0].x,face.vertexNormals[0].y, face.vertexNormals[0].z);
                        unsafe._mem_i32[(t + 24) >> 2] = XRAY.Vector.NewVector(face.vertexNormals[1].x,face.vertexNormals[1].y, face.vertexNormals[1].z);
                        unsafe._mem_i32[(t + 28) >> 2] = XRAY.Vector.NewVector(face.vertexNormals[2].x,face.vertexNormals[2].y, face.vertexNormals[2].z);

                        triangles.push(t);
                    }
                } else {
                    return null;
                }

            } else {

                let positions = geometry.attributes["position"].array;
                let uv;
                if (geometry.attributes["uv"]) {
                    uv = geometry.attributes["uv"].array;
                }

                let normals;
                if (geometry.attributes["normal"]) {
                    normals = geometry.attributes["normal"].array;
                } else {
                    normals = computeNormals(positions);
                }
                let triCount = 0;
                let indexAttribute = geometry.getIndex();

                if (indexAttribute) {

                    let indices = indexAttribute.array;
                    let uvIndex = 0;

                    for (let i = 0; i < indices.length; i = i + 3) {

                        triCount++;

                        let a;
                        let b;
                        let c;

                        a = indices[i];
                        b = indices[i + 1];
                        c = indices[i + 2];

                        if (triCount % 2 !== 0) {
                            a = indices[i];
                            b = indices[i + 1];
                            c = indices[i + 2];
                        } else {
                            c = indices[i];
                            b = indices[i + 1];
                            a = indices[i + 2];
                        }

                        //[....,ax,ay,az, bx,by,bz, cx,xy,xz,....]
                        let ax = a * 3;
                        let ay = (a * 3) + 1;
                        let az = (a * 3) + 2;

                        let bx = b * 3;
                        let by = (b * 3) + 1;
                        let bz = (b * 3) + 2;

                        let cx = c * 3;
                        let cy = (c * 3) + 1;
                        let cz = (c * 3) + 2;

                        let au = a * 2;
                        let av = (a * 2) + 1;

                        let bu = b * 2;
                        let bv = (b * 2) + 1;

                        let cu = c * 2;
                        let cv = (c * 2) + 1;

                        let t = XRAY.Triangle.initInstance(unsafe.alloc(53, 4));
                        unsafe._mem_i32[(t + 44) >> 2] = material;
                        unsafe._mem_i32[(t + 8) >> 2] = XRAY.Vector.NewVector(positions[ax], positions[ay], positions[az]);
                        unsafe._mem_i32[(t + 12) >> 2] = XRAY.Vector.NewVector(positions[bx], positions[by], positions[bz]);
                        unsafe._mem_i32[(t + 16) >> 2] = XRAY.Vector.NewVector(positions[cx], positions[cy], positions[cz]);

                        unsafe._mem_i32[(t + 20) >> 2] = XRAY.Vector.NewVector(normals[ax], normals[ay], normals[az]);
                        unsafe._mem_i32[(t + 24) >> 2] = XRAY.Vector.NewVector(normals[bx], normals[by], normals[bz]);
                        unsafe._mem_i32[(t + 28) >> 2] = XRAY.Vector.NewVector(normals[cx], normals[cy], normals[cz]);

                        if (uv) {
                            unsafe._mem_i32[(t + 32) >> 2] = XRAY.Vector.NewVector(uv[au], uv[av], 0);
                            unsafe._mem_i32[(t + 36) >> 2] = XRAY.Vector.NewVector(uv[bu], uv[bv], 0);
                            unsafe._mem_i32[(t + 40) >> 2] = XRAY.Vector.NewVector(uv[cu], uv[cv], 0);
                        }

                        triangles.push(t);
                        uvIndex += 2;
                    }

                } else {
                    let uvIndex = 0;
                    for (let i = 0; i < positions.length; i = i + 9) {

                        let t = XRAY.Triangle.initInstance(unsafe.alloc(53, 4));
                        unsafe._mem_i32[(t + 44) >> 2] = material;

                        unsafe._mem_i32[(t + 8) >> 2] = XRAY.Vector.NewVector(positions[i], positions[i + 1], positions[i + 2]);
                        unsafe._mem_i32[(t + 12) >> 2] = XRAY.Vector.NewVector(positions[i + 3], positions[i + 4], positions[i + 5]);
                        unsafe._mem_i32[(t + 16) >> 2] = XRAY.Vector.NewVector(positions[i + 6], positions[i + 7], positions[i + 8]);

                        unsafe._mem_i32[(t + 20) >> 2] = XRAY.Vector.NewVector(normals[i], normals[i + 1], normals[i + 2]);
                        unsafe._mem_i32[(t + 24) >> 2] = XRAY.Vector.NewVector(normals[i + 3], normals[i + 4], normals[i + 5]);
                        unsafe._mem_i32[(t + 28) >> 2] = XRAY.Vector.NewVector(normals[i + 6], normals[i + 7], normals[i + 8]);

                        if (uv) {
                            unsafe._mem_i32[(t + 32) >> 2] = XRAY.Vector.NewVector(uv[uvIndex], uv[uvIndex + 1], 0);
                            unsafe._mem_i32[(t + 36) >> 2] = XRAY.Vector.NewVector(uv[uvIndex + 2], uv[uvIndex + 3], 0);
                            unsafe._mem_i32[(t + 40) >> 2] = XRAY.Vector.NewVector(uv[uvIndex + 4], uv[uvIndex + 5], 0);
                        }

                        //XRAY.Triangle.UpdateBox(t);
                        XRAY.Triangle.FixNormals(t);
                        // triangle.fixNormals();
                        // triangle.updateBox();
                        triangles.push(t);
                        uvIndex += 6;
                    }
                }
            }
            let meshRef = XRAY.Mesh.NewMesh(XRAY.Triangle.Pack(triangles), material);
            if (smooth) {
                XRAY.Mesh.SmoothNormals(meshRef);
            }
            return meshRef;
        }

        let computeNormals = function (positions) {
            return new Float32Array(positions.length);
        };

        function getTurboLight(src) {
            let _radius;
            let material = XRAY.Material.LightMaterial(XRAY.Color.HexColor(src.color.getHex()), src.intensity * 500);
            let shape;

            if (src.children.length > 0) {
                let lightGeometry = src.children[0].geometry;
                if (lightGeometry instanceof THREE.SphereGeometry) {
                    _radius = lightGeometry.parameters.radius;
                }
            }

            _radius = _radius ? _radius : 1;
            shape = XRAY.Sphere.NewSphere(XRAY.Vector.NewVector(src.position.x, src.position.y, src.position.z), _radius, material);
            // shape = XRAY.Sphere.NewSphere(XRAY.Vector.NewVector(), _radius, material);

            return shape;
            //FIXME: Transformed light is broken
            // let mat = XRAY.Matrix.fromTHREEJS(src.matrix.elements);
            // return XRAY.TransformedShape.NewTransformedShape(shape, mat);
            //
            // if (src.matrix.equals(identityMatrix)) {
            //     return shape;
            // } else {
            //     let mat = XRAY.Matrix.fromTHREEJS(src.matrix.elements);
            //     return XRAY.TransformedShape.NewTransformedShape(shape, mat);
            // }
        }
    };
    XRayView.getTurboMaterial = function (srcMaterial) {
        if (srcMaterial instanceof THREE.MultiMaterial) {
            srcMaterial = srcMaterial.materials[0];
        }
        let material;
        let emissiveColor = srcMaterial.emissive.getHex();
        if(emissiveColor > 0){
            let intensity = 1;
            if(srcMaterial.name && srcMaterial.name != "" && srcMaterial.name.indexOf("intensity") > -1){
                intensity = srcMaterial.name.split("intensity_")[1];
            }else{
                let emissiveHSL = srcMaterial.emissive.getHSL();
                intensity = srcMaterial.intensity ? srcMaterial.intensity : emissiveHSL.l;
            }
            material = XRAY.Material.LightMaterial(XRAY.Color.HexColor(srcMaterial.color.getHex()), intensity * 10);
             if(srcMaterial.map){
                let image = srcMaterial.map.image;
                let imgData = XRAY.TextureUtils.getImageData(image);
                if(imgData) {
                    let texture = XRAY.Texture.NewTexture(imgData, image.width, image.height);
                    XRAY.Material.setTexture(material, texture);
                }
            }
            material.isLight = true;
        }else {
            material = XRAY.Material.DiffuseMaterial(XRAY.Color.HexColor(srcMaterial.color.getHex()));
            XRAY.Material.setIndex(material, srcMaterial.ior ? srcMaterial.ior : 1.3);
            XRAY.Material.setTint(material, srcMaterial.tint ? srcMaterial.tint : 0);
            XRAY.Material.setGloss(material, srcMaterial.gloss ? srcMaterial.gloss : 0);
            XRAY.Material.setTransparent(material, srcMaterial.transparent ? 1 : 0);

            if(srcMaterial.map){
                let image = srcMaterial.map.image;
                let imgData = XRAY.TextureUtils.getImageData(image);
                if(imgData) {
                    let texture = XRAY.Texture.NewTexture(imgData, image.width, image.height);
                    XRAY.Material.setTexture(material, texture);
                }
            }
            if(srcMaterial.bumpMap){
                let image = srcMaterial.bumpMap.image;
                let imgData = XRAY.TextureUtils.getImageData(image);
                if(imgData) {
                    let texture = XRAY.Texture.NewTexture(imgData, image.width, image.height);
                    XRAY.Material.setBumpTexture(material, texture);
                    XRAY.Material.setBumpMultiplier(material, srcMaterial.bumpScale);
                }
            }
            if(srcMaterial.roughnessMap){
                let image = srcMaterial.roughnessMap.image;
                let imgData = XRAY.TextureUtils.getImageData(image);
                if(imgData) {
                    let texture = XRAY.Texture.NewTexture(imgData, image.width, image.height);
                    XRAY.Material.setBumpTexture(material, texture);
                }
            }

            material.isLight = false;
        }
        return material;
    };
    XRAY.XRayView = XRayView;
})(XRAY);

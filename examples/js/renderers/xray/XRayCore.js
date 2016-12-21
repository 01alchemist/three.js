var XRAY = XRAY || {};
(function XRayCore(XRAY) {

    /**
     * Thread pool
     */
    var ThreadPool = {}
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
        var threads = [];
        for (var i = 0; i < ThreadPool.maxThreads; i++) {
            threads.push(new Thread("Thread:#" + i, i));
        }
        ThreadPool.pool = threads;
        return threads;
    }
    XRAY.ThreadPool = ThreadPool;

    /**
     * Thread
     */
    var Thread = function Thread(name, id) {
        this.initialized = false;
        this.name = name;
        this.id = id;
        var _isTracing = false;

        Object.defineProperty(this, "isTracing", {
            get: function () {
                return _isTracing;
            }
        });
        try {
            var instance = new Worker(Thread.workerUrl);
        } catch (e) {
            console.log(e);
        }
        instance.onmessage = onMessageReceived.bind(this);

        function onMessageReceived(event) {
            if (event.data == TraceJob.INITIALIZED) {
                this.initialized = true;
                _isTracing = false;
                if (this.onInitComplete) {
                    this.onInitComplete(this);
                }
            }
            if (event.data == TraceJob.TRACED) {
                _isTracing = false;
                TraceManager.flags[3 + this.id] = 0;
                if (this.onTraceComplete) {
                    this.onTraceComplete(this);
                }
            }
            if (event.data == TraceJob.LOCKED) {
                _isTracing = false;
                TraceManager.flags[3 + this.id] = 3;
                if (this.onThreadLocked) {
                    this.onThreadLocked(this);
                }
            }
        }

        this.init = function (parameters, transferable, onInit) {
            // console.log("Initializing thread " + this.id);
            this.onInitComplete = onInit;
            parameters.command = TraceJob.INIT;
            parameters.id = this.id;
            this.send(parameters, transferable);
        }

        this.update = function (parameters) {
            parameters.command = TraceJob.UPDATE;
            this.send(parameters);
        }

        this.trace = function (parameters, onComplete) {
            if (TraceManager.flags[3 + this.id] == 2) {
                _isTracing = false;
                TraceManager.flags[3 + this.id] = 3;
                if (this.onThreadLocked) {
                    this.onThreadLocked(this);
                }
            }
            else {
                _isTracing = true;
                TraceManager.flags[3 + this.id] = 1;
                this.onTraceComplete = onComplete;
                parameters.command = TraceJob.TRACE;
                this.send(parameters);
            }
        }

        this.send = function (data, buffers) {
            if (navigator.userAgent.indexOf("Firefox") > -1) {
                instance.postMessage(data);
            } else {
                instance.postMessage(data, buffers);
            }
        }

        this.terminate = function () {
            //this.onTraceComplete = null;
            //this.send(TraceJob.TERMINATE);
        }
    }
    Thread.workerUrl = "../examples/js/renderers/xray/XRayWorker.js";
    XRAY.Thread = Thread;

    /**
     * Trace job
     */
    var TraceJob = function TraceJob(renderOptions) {
        this.parameters = renderOptions;
        this.finished = false;
        this.runCount = 0;
        var time = 0;

        Object.defineProperty(this, "time", {
            get: function () {
                return time;
            }
        })

        this.start = function (thread, onComplete) {
            var startTime = performance.now();
            var parameters = this.getTraceParameters();
            thread.trace(parameters, function (thread) {
                time = performance.now() - startTime;
                if (onComplete) {
                    onComplete(this, thread);
                }
            }.bind(this));

            this.runCount++;
        }

        this.getTraceParameters = function () {

            var parameters = { init_iterations: 0 };
            var extraCount = 0;
            for (key in this.extra) {
                if (this.extra.hasOwnProperty(key)) {
                    parameters[key] = this.extra[key];
                    delete this.extra[key];
                    extraCount++;
                }
            }
            if (extraCount > 0) {
                for (var key in renderOptions) {
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
    }
    TraceJob.INIT = "INIT";
    TraceJob.UPDATE = "UPDATE";
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
    var TraceManager = function TraceManager() {

        var queue = [];
        var deferredQueue = [];
        var referenceQueue = [];
        var iterations;

        var width;
        var height;
        var flags;
        var traceParameters;
        var threads;
        var initCount = 0;
        var maxLoop = 1;
        var currentLoop = 0;
        var totalThreads = 0;
        var _initialized;
        var _isIterationFinished = true;
        var _isRenderingFinished = true;
        var _await;
        var deferredStart = false;
        var stopped = true;
        var lockCount = 0;
        var maxWidth = 1920;
        var maxHeight = 1080;

        this.configure = function (parameters) {

            width = parameters.width;
            height = parameters.height;
            maxLoop = parameters.maxLoop;

            flags = new Uint8Array(new SharedArrayBuffer(ThreadPool.maxThreads));
            TraceManager.flags = flags;
            this.pixelMemory = new Uint8Array(new SharedArrayBuffer(maxWidth * maxHeight * 3));
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
        }

        this.update = function (parameters) {

            if (!stopped) {
                this.stop();
            }

            this.clear();

            width = parameters.width;
            height = parameters.height;
            traceParameters.imageWidth = parameters.width;
            traceParameters.imageHeight = parameters.height;

            // this.pixelMemory = new Uint8Array(new SharedArrayBuffer(width * height * 3));
            // this.sampleMemory = new Float32Array(new SharedArrayBuffer(4 * width * height * 3));

            // traceParameters.pixelBuffer = this.pixelMemory.buffer;
            // traceParameters.sampleBuffer = this.sampleMemory.buffer;

            threads.forEach(function (thread) {
                thread.update(parameters);
            });

            if (!_isRenderingFinished) {
                this.restart();
            }
        }

        this.add = function (job) {
            queue.push(job);
            referenceQueue.push(job);
        }

        this.init = function (callback) {
            console.log("Initializing threads...");
            console.time(ThreadPool.maxThreads + " Threads initialized");
            threads = ThreadPool.getThreads();
            totalThreads = threads.length;
            lockCount = threads.length;
            initNext(callback);
        }

        function initNext(callback) {

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

            var thread = threads[initCount++];
            thread.onThreadLocked = onThreadLocked.bind(this);
            thread.init(traceParameters, [
                traceParameters.flagsBuffer,
                traceParameters.pixelBuffer,
                traceParameters.sampleBuffer,
                traceParameters.turboBuffer
            ], function () {
                initNext.call(this, callback);
            }.bind(this));
        }

        function onThreadLocked() {
            lockCount++;
            if (this.isAllLocked && deferredStart) {
                deferredStart = false;
                this.clear();
                this.restart();
            }
            console.log("lockCount:" + lockCount);
        }

        Object.defineProperty(this, "isAllThreadsFree", {
            get: function () {
                var thread;
                for (var i = 0; i < threads.length; i++) {
                    thread = threads[i];
                    if (thread.isTracing) {
                        if (flags[3 + i] === 1 || flags[3 + i] === 2) {
                            return false;
                        }
                    }

                }
                return true;
            }
        });

        this.lockAllThreads = function () {
            for (var i = 0; i < threads.length; i++) {
                var thread = threads[i];
                if (thread.isTracing) {
                    flags[3 + i] = 2;
                } else {
                    flags[3 + i] = 0;
                }
            }
        }

        this.stop = function () {

            if (!stopped) {
                //console.timeEnd('trace::iteration completed');
            }

            if (flags) {
                queue = null;
                deferredQueue = null;
                deferredStart = false;
                this.lockAllThreads();
                stopped = true;
                lockCount = 0;
                _await = true;
                var job;

                for (var i = 0; i < referenceQueue.length; i++) {
                    job = referenceQueue[i];
                    job.runCount = 0;
                }
            }
        }

        this.clear = function () {
            for (var y = 0; y < height; y++) {
                for (var x = 0; x < width; x++) {
                    var si = (y * (width * 3)) + (x * 3);

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
        }

        resetTimerId = 0;

        this.restart = function () {
            if (!stopped) {
                this.stop();
            }
            currentLoop = 0;
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
        }

        this.start = function () {
            if (currentLoop >= maxLoop || (queue && queue.length == 0 && deferredQueue.length === 0)) {
                if (!_isRenderingFinished) {
                    console.log("Rendering finished");
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
                    _isRenderingFinished = false;
                }

                var thread;
                var job;

                for (var i = 0; i < threads.length; i++) {
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
        }

        this.processQueue = function (job, thread) {
            if (this.updatePixels) {
                this.updatePixels(job.parameters, this.pixelMemory);
            }
            if (_isIterationFinished) {
                return;
            }

            if (queue.length > 0) {

                var job = queue.shift();
                deferredQueue.push(job);

                // if (this.updateIndicator) {
                //     this.updateIndicator(job.parameters);
                // }

                job.start(thread, function (_job, _thread) {
                    if (!_await) {
                        this.processQueue.call(this, _job, _thread);
                    }
                }.bind(this));

            } else {
                if (this.isAllThreadsFree) {
                    _isIterationFinished = true;
                    //console.timeEnd('trace::iteration completed');
                    this.initDeferredQueue();
                }
            }
        }

        this.initDeferredQueue = function () {

            if (currentLoop >= maxLoop || (queue.length == 0 && deferredQueue.length === 0)) {
                if (!_isRenderingFinished) {
                    console.log("Rendering finished");
                    _isRenderingFinished = true;
                }
                return;
            }

            currentLoop++;
            _isIterationFinished = false;
            deferredQueue.sort(function (a, b) {
                return b.time - a.time;
            });
            queue = deferredQueue;

            deferredQueue = [];

            //console.time('trace::iteration completed');
            this.start();
        }

    }
    XRAY.TraceManager = TraceManager;

    /**
     * XRay view
     */
    var XRayView = function XRayView(sceneColor) {
        this.scene = new XRAY.MasterScene(sceneColor || 0);
        this.camera = XRAY.Camera.LookAt(
            XRAY.Vector.NewVector(0, 10, 0),
            XRAY.Vector.NewVector(0, 0, 0),
            XRAY.Vector.NewVector(0, 0, 1),
            45
        );

        this.setScene = function (scene) {
            console.time("Scene builder");
            this.loadChildren(scene);
            this.scene.Commit();
            console.timeEnd("Scene builder");
        }

        this.updateCamera = function (camera, ratioX, ratioY, ratioZ) {
            if (ratioX === void 0) { ratioX = 1; }
            if (ratioY === void 0) { ratioY = 1; }
            if (ratioZ === void 0) { ratioZ = 1; }
            let e = camera.matrix.elements;
            let x = { x: -e[0], y: -e[1], z: -e[2] };
            let y = { x: e[4], y: e[5], z: e[6] };
            let z = { x: -e[8], y: -e[9], z: -e[10] };

            var pos = {
                x: camera.position.x * ratioX,
                y: camera.position.y * ratioY,
                z: camera.position.z * ratioZ
            }

            XRAY.Camera.SetFromJSON(this.camera, {
                p: pos,
                u: x,
                v: y,
                w: z,
                m: 1 / Math.tan(camera.fov * Math.PI / 360)
            });

            this.dirty = true;
        }

        // Prepare three.js scene
        var identityMatrix = new THREE.Matrix4().identity();

        this.loadChildren = function (parent) {
            var child;
            for (var i = 0; i < parent.children.length; i++) {
                child = parent.children[i];

                var obj = buildSceneObject(child);
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
        }

        function buildSceneObject(src) {

            switch (src.type) {
                case "Mesh":
                    var material = XRayView.getTurboMaterial(src.material);
                    var shape = buildTurboGeometry(src.geometry, material, src.smooth);

                    var matrixWorld = src.matrixWorld;

                    if (matrixWorld.equals(identityMatrix)) {
                        return shape;
                    } else {
                        var mat = XRAY.Matrix.fromTHREEJS(matrixWorld.elements);
                        return XRAY.TransformedShape.NewTransformedShape(shape, mat);
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

            var triangles = [];

            if (!geometry.attributes) {

                var vertices = geometry.vertices;
                var faces = geometry.faces;
                if (vertices && faces) {
                    for (var i = 0; i < faces.length; i++) {
                        var face = faces[i];
                        var t = XRAY.Triangle.initInstance(unsafe.alloc(53, 4));

                        unsafe._mem_i32[(t + 44) >> 2] = material;
                        unsafe._mem_i32[(t + 8) >> 2] = XRAY.Vector.NewVector(vertices[face.a].x, vertices[face.a].y, vertices[face.a].z);
                        unsafe._mem_i32[(t + 12) >> 2] = XRAY.Vector.NewVector(vertices[face.b].x, vertices[face.b].y, vertices[face.b].z);
                        unsafe._mem_i32[(t + 16) >> 2] = XRAY.Vector.NewVector(vertices[face.c].x, vertices[face.c].y, vertices[face.c].z);
                        unsafe._mem_i32[(t + 20) >> 2] = XRAY.Vector.NewVector();
                        unsafe._mem_i32[(t + 24) >> 2] = XRAY.Vector.NewVector();
                        unsafe._mem_i32[(t + 28) >> 2] = XRAY.Vector.NewVector();

                        triangles.push(t);
                    }
                } else {
                    return null;
                }

            } else {

                var positions = geometry.attributes["position"].array;
                if (geometry.attributes["uv"]) {
                    var uv = geometry.attributes["uv"].array;
                }

                var normals;
                if (geometry.attributes["normal"]) {
                    normals = geometry.attributes["normal"].array;
                } else {
                    normals = computeNormals(positions);
                }
                var triCount = 0;
                var indexAttribute = geometry.getIndex();

                if (indexAttribute) {

                    var indices = indexAttribute.array;
                    var uvIndex = 0;

                    for (var i = 0; i < indices.length; i = i + 3) {

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
                    uvIndex = 0;
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
            let meshRef = XRAY.Mesh.NewMesh(XRAY.Triangle.Pack(triangles));
            // Mesh.SmoothNormals(meshRef);
            return meshRef;
        }

        computeNormals = function (positions) {
            return new Float32Array(positions.length);
        }
        function getTurboLight(src) {
            if (src.children.length > 0) {
                var lightGeometry = src.children[0].geometry;
                if (lightGeometry instanceof THREE.SphereGeometry) {
                    var _radius = lightGeometry.parameters.radius;
                } else if (lightGeometry instanceof THREE.PlaneGeometry) {
                    var width = lightGeometry.parameters.width;
                    var height = lightGeometry.parameters.height;
                }
                // _radius = lightGeometry.boundingSphere.radius;
            }
            _radius = _radius ? _radius : 1;
            console.log(`intensity:${src.intensity}`);
            var material = XRAY.Material.LightMaterial(XRAY.Color.HexColor(src.color.getHex()), src.intensity * 10);
            if (_radius) {
                var shape = XRAY.Sphere.NewSphere(XRAY.Vector.NewVector(src.position.x, src.position.y, src.position.z), _radius, material); ``
                // var shape = xSphere.NewSphere(XRAY.Vector.NewVector(), _radius, material);
            } else {
                shape = XRAY.Cube.NewCube(
                    // new Vector3(src.position.x - width / 2, src.position.y, src.position.z - height / 2),
                    // new Vector3(src.position.x + width / 2, src.position.y, src.position.z + height / 2),
                    XRAY.Vector.NewVector(-width / 2, src.position.y, -height / 2),
                    XRAY.Vector.NewVector(width / 2, src.position.y + 1, height / 2),
                    material);
            }
            return shape;
            // var mat:Matrix = Matrix4.fromTHREEJS(src.matrix.elements);
            // return TransformedShape.newTransformedShape(sphere, mat);
            if (src.matrix.equals(this.identityMatrix)) {
                return shape;
            } else {
                var mat = XRAY.Matrix.fromTHREEJS(src.matrix.elements);
                return XRAY.TransformedShape.NewTransformedShape(shape, mat);
            }
        }
    }
    XRayView.getTurboMaterial = function (srcMaterial) {
        if (srcMaterial instanceof THREE.MultiMaterial) {
            srcMaterial = srcMaterial.materials[0];
        }

        var material = XRAY.Material.DiffuseMaterial(XRAY.Color.HexColor(srcMaterial.color.getHex()));

        XRAY.Material.setIndex(material, srcMaterial.ior ? srcMaterial.ior : 1);
        XRAY.Material.setTint(material, srcMaterial.tint ? srcMaterial.tint : 0);
        XRAY.Material.setGloss(material, srcMaterial.gloss ? srcMaterial.gloss : 0);
        XRAY.Material.setEmittance(material, srcMaterial.emittance ? srcMaterial.emittance : 0);
        XRAY.Material.setTransparent(material, srcMaterial.transparent ? 1 : 0);

        return material;
    }
    XRAY.XRayView = XRayView;
})(XRAY);
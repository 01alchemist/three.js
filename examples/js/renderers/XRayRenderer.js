/**
 * XRayRenderer renders by pathtracing it's scene. 
 * Rendering job is distributed between available CPUs using SharedArrayBuffer
 * @author 01alchemist (Nidin Vinayakan) / http://github.com/01alchemist
 */

var XRAY = XRAY || {};

THREE.XRayRenderer = function (parameters) {

	console.log('THREE.XRayRenderer', "v1.0.0");

	this.XRAY = true;

	var _super = THREE.WebGLRenderer;
	_super.call(this);

	//XRay members
	var initialized = false;
	var initializing = false;
	var container;
	var canvas;
	var context;
	var imageData;
	var view;
	var traceManager;
	this.threejsScene = null;
	var bucketSize = 64;
	//Render options
	var cameraSamples = -1;
	var hitSamples = 1;
	var bounces = 4;
	var targetIterations = 100;
	var blockIterations = 1;

	var maxWidth = 1920;
	var maxHeight = 1080;
	var width = 1280 / 2;
	var height = 720 / 2;
	var xOffset = 0;
	var yOffset = 0;
	var webglWidth;
	var webglHeight;

	//Internals
	var _traceState = false;

	_super.setSize = this.setSize;

	this.setSize = function (_width, _height, updateStyle) {

		width = _width;
		height = _height;
		webglWidth = _width;
		webglHeight = _height;

		//xOffset = (_width - width) / 2;
		//yOffset = (_height - height) / 2;
		// width = _width //- xOffset;
		//height = _height //- yOffset;

		updateRenderer();

		_super.setSize.call(this, _width, _height, updateStyle);

	}

	_super.setPixelRatio = this.setPixelRatio;

	this.setPixelRatio = function (value) {
		_pixelRatio = value;
		_super.setPixelRatio.call(this, value);
	}

	_super.setClearColor = this.setClearColor;

	this.setClearColor = function (color, alpha) {

		if (view && view.scene) {
			view.scene.setClearColor(color);
		}
		_super.setClearColor.call(this, color, alpha);

	}

	_super.clear = this.clear;

	this.clear = function () {

		_super.clear.call(this);

	}

	_super.render = this.render;

	this.render = function (scene, camera) {

		if (view && !this.threejsScene) {
			this.threejsScene = scene;
			if(!initialized && !initializing) {
				initializing = true;
				view.setScene(scene);
                this.setupTracer();

                traceManager.init(function () {
                    console.log("Ready to start");
                    updateCamera(camera);
                    traceManager.start();
                    _traceState = true;
                    initialized = true;
                    initializing = false;
                });
            }else{
				updateCamera(camera);
				if (_traceState) {
					traceManager.stop();
					traceManager.clear();
					traceManager.restart();
				}
			}
		}

		_super.render.call(this, scene, camera);

	}

	/**
	 * XRay specific methods
	 */
	this.toggleGIView = function (newValue) {
		canvas.style.display = newValue ? "" : "none";
		_traceState = newValue;
		if (_traceState) {
			traceManager.restart();
		} else {
			traceManager.stop();
			traceManager.clear();
		}
	}

	this.initialize = function (maxMemory) {

		if (typeof turbo === "undefined") {
			if (typeof SharedArrayBuffer !== "undefined") {
				console.warn("XRayRuntime not inilialized, load XRayRuntime.js before XRayRenderer.js");
			}
		} else {
			turbo.init(maxMemory || 1024);
			Initialize_XRayKernel(XRAY);
			setTimeout(this.setupRenderer.bind(this), 0);
		}
	}

	/**
	 * Setup XRay renderer
	 */
	this.setupRenderer = function () {
        container = document.createElement('div');
        canvas = document.createElement('canvas');
        container.style.pointerEvents = "none";
        canvas.style.pointerEvents = "none";
        container.style.border = "1px solid #C58F33";
        container.style.display = "block";
        context = canvas.getContext('2d');
        imageData = context.getImageData(0, 0, width, height);

        container.width = width;
        container.height = height;
        canvas.width = width;
        canvas.height = height;
        container.style.position = "absolute";
        container.style.left = xOffset + "px";
        container.style.top = yOffset + "px";

        container.appendChild(canvas);
        this.domElement.parentElement.appendChild(container);

        view = new XRAY.XRayView(0x000000);
        // view.scene.AddDebugScene();
        // view.scene.AddDefaultLights();
    };

    this.setupTracer = function () {
		traceManager = new XRAY.TraceManager();
		traceManager.configure({
			camera: view.camera,
			scene: view.scene.scenePtr,
			width: width,
			height: height,
			webglWidth: webglWidth,
			webglHeight: webglHeight,
			cameraSamples: cameraSamples,
			hitSamples: hitSamples,
			bounces: bounces,
			maxLoop: targetIterations
		});

		var col = width / bucketSize;
		var row = height / bucketSize;

		for (var j = 0; j < row; j++) {
			for (var i = 0; i < col; i++) {
				traceManager.add(
					new XRAY.TraceJob({
						id: j + "_" + i,
						blockIterations: blockIterations,
						width: bucketSize,
						height: bucketSize,
						xoffset: i * bucketSize,
						yoffset: j * bucketSize
					})
				);
			}
		}

		traceManager.updatePixels = updatePixelsRect.bind(this);
		traceManager.updateIndicator = updateIndicator.bind(this);
		var timeoutid = 0;
		editor.signals.cameraChanged.add(function () {
			clearCanvas();
			updateCamera(editor.camera);
			canvas.style.display = "none";

			if (traceManager) {
				traceManager.stop();
				traceManager.clear();
			}
			clearTimeout(timeoutid);
			timeoutid = setTimeout(function () {
				if (_traceState) {
					traceManager.restart();
					canvas.style.display = "";
				}
			}, 500);
		});
	}

	function updateCamera(camera) {
		if (view) {
			var ratio1 = width / webglWidth;
			var ratio2 = height / webglHeight;
			var ratio = ratio1 < ratio2 ? ratio1 : ratio2;
			view.updateCamera(editor.camera);
		}
	}

	this.updateScene = function (scene) {
		traceManager.stop();
		traceManager.clear();
		view.setScene(scene);
		traceManager.update({scene:view.scene.scenePtr});
		if (_traceState) {
			//traceManager.restart();
		}
    };

	function updateRenderer() {

		if (canvas) {
			container.style.width = width + "px";
        	container.style.height = height + "px";
			container.style.left = xOffset + "px";
			container.style.top = yOffset + "px";

			canvas.width = width;
			canvas.height = height;

			imageData = context.getImageData(0, 0, width, height);
		}

		if (traceManager) {
			console.log(`Renderer updated:: width: ${width}, height: ${height}`);

			traceManager.update({
				width: width,
				height: height
			});
		}

		updateCamera(editor.camera);
	}

	function clearCanvas() {

		var data = imageData.data;
		for (var y = 0; y < height; y++) {
			for (var x = 0; x < width; x++) {

				var i = y * (width * 4) + (x * 4);
				var pi = y * (width * 3) + (x * 3);
				data[i] = 0;
				data[i + 1] = 0;
				data[i + 2] = 0;
				data[i + 3] = 255;
			}
		}
		context.putImageData(imageData, 0, 0);
	}

	function updatePixelsRect(rect, pixels) {

		var data = imageData.data;
		for (var y = rect.yoffset; y < rect.yoffset + rect.height; y++) {
			for (var x = rect.xoffset; x < rect.xoffset + rect.width; x++) {

				var i = y * (width * 4) + (x * 4);
				var pi = y * (width * 3) + (x * 3);
				data[i] = pixels[pi];
				data[i + 1] = pixels[pi + 1];
				data[i + 2] = pixels[pi + 2];
				data[i + 3] = 255;
			}
		}
		context.putImageData(imageData, 0, 0);
	}

	function updateIndicator(rect) {

		var color = randomColor();

		//top-left
		fillRect({ x: rect.xoffset, y: rect.yoffset, width: 4, height: 1 }, color);
		fillRect({ x: rect.xoffset, y: rect.yoffset + 1, width: 1, height: 3 }, color);

		//top-right
		fillRect({ x: rect.xoffset + rect.width - 4, y: rect.yoffset, width: 4, height: 1 }, color);
		fillRect({ x: rect.xoffset + rect.width - 1, y: rect.yoffset + 1, width: 1, height: 3 }, color);

		//bottom-left
		fillRect({ x: rect.xoffset, y: rect.yoffset + rect.height - 4, width: 1, height: 4 }, color);
		fillRect({ x: rect.xoffset + 1, y: rect.yoffset + rect.height - 1, width: 3, height: 1 }, color);

		//bottom-right
		fillRect({ x: rect.xoffset + rect.width - 4, y: rect.yoffset + rect.height - 1, width: 4, height: 1 }, color);
		fillRect({ x: rect.xoffset + rect.width - 1, y: rect.yoffset + rect.height - 4, width: 1, height: 3 }, color);

		context.putImageData(imageData, 0, 0);
	}

	function fillRect(rect, color) {
		var data = imageData.data;
		for (var y = rect.y; y < rect.y + rect.height; y++) {
			for (var x = rect.x; x < rect.x + rect.width; x++) {

				var i = y * (width * 4) + (x * 4);
				data[i] = color.r * 255;
				data[i + 1] = color.g * 255;
				data[i + 2] = color.b * 255;
				data[i + 3] = 255;
			}
		}
		context.putImageData(imageData, 0, 0);
	}

	function randomColor() {
		return { r: Math.random(), g: Math.random(), b: Math.random() };
	}

	//XRAY.ThreadPool.overrideMaxThreads = 1;
	this.initialize();

};

Object.assign(THREE.XRayRenderer.prototype, THREE.WebGLRenderer.prototype);
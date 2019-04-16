/**
 * XRayRenderer renders by pathtracing it's scene. 
 * Rendering job is distributed between available CPUs using SharedArrayBuffer
 * @author 01alchemist (Nidin Vinayakan) / http://github.com/01alchemist
 */

var XRAY = XRAY || {};

THREE.XRayRenderer = function (parameters) {

	console.log('THREE.XRayRenderer', "v1.0.0");

	this.XRAY = true;

	let _super = THREE.WebGLRenderer;
	_super.call(this);

	//XRay members
	let initialized = false;
	let initializing = false;
	let container = null;
	let canvas;
	let context;
	let imageData;
	let view;
	let traceManager;
	this.threejsScene = null;
	let bucketSize = 64;
	//Render options
	let cameraSamples = -1;
	let hitSamples = 1;
	let bounces = 3;
	let targetIterations = 1000;
	let blockIterations = 1;

	let maxWidth = 1920;
	let maxHeight = 1080;
	let width = 1280 / 2;
	let height = 720 / 2;
	let xOffset = 0;
	let yOffset = 0;
	let webglWidth;
	let webglHeight;

	//Internals
	let _traceState = false;
	let _viewState = false;

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

		updateRenderer.call(this);

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
		this.threejsScene = scene;
		this.threejsCamera = camera;
		if (view && !initialized) {
			this.initializeRenderer(scene, camera);
		}

		_super.render.call(this, scene, camera);

	}

	/**
	 * XRay specific methods
	 */
	this.updateBackground = function (newValue) {
		if(view){
			view.scene.setClearColor(newValue);
		}
	};
	this.toggleGIView = function (newValue) {
		canvas.style.display = newValue ? "" : "none";
		_viewState = newValue;
	};

	this.toggleTrace = function (newValue) {
		_traceState = newValue;
		if (_traceState) {
			if(!initialized){
				this.initializeRenderer(this.threejsScene, this.threejsCamera);
			}
			traceManager.clear();
			traceManager.restart();
		} else {
			traceManager.stop();
		}
	};

	let initialize = (maxMemory) => {

		if (typeof turbo === "undefined") {
			if (typeof SharedArrayBuffer !== "undefined") {
				console.warn("XRayRuntime not inilialized, load XRayRuntime.js before XRayRenderer.js");
			}
		} else {
			turbo.init(maxMemory || 1024);
			Initialize_XRayKernel(XRAY);
			console.log("XRay kernel inilialized");
			setTimeout(this.setupRenderer.bind(this), 0);
		}
	};

	/**
	 * Setup XRay renderer
	 */
	this.initializeRenderer = function (scene, camera) {
		if(!initialized && !initializing) {
			initializing = true;
			if(!view){
				this.setupRenderer();
			}
			view.setScene(scene);
			this.setupTracer();

			traceManager.init(() => {
				console.log("Ready to start");
				this.updateCamera(camera);
				if(_traceState){
					traceManager.start();
                }
				initialized = true;
				initializing = false;
			});
		}else{
			// this.updateCamera(camera);
			// if (_traceState && traceManager) {
			// 	traceManager.stop();
			// 	traceManager.clear();
			// 	traceManager.restart();
			// }
		}
    };

	this.setupRenderer = () => {
		if(container){
			return;
		}
        container = document.createElement('div');
        canvas = document.createElement('canvas');
        container.style.pointerEvents = "none";
        canvas.style.pointerEvents = "none";
        container.style.border = "1px solid #C58F33";
        container.style.display = "block";
        context = canvas.getContext('2d', {alpha:false});
        imageData = context.getImageData(0, 0, width, height);

        container.width = width;
        container.height = height;
        canvas.width = width;
        canvas.height = height;
        container.style.position = "absolute";
        container.style.left = xOffset + "px";
        container.style.top = yOffset + "px";

        this.toggleGIView(_viewState);

        container.appendChild(canvas);
        this.domElement.parentElement.appendChild(container);

        view = new XRAY.XRayView(0x000000);
        // view.scene.AddDebugScene();
        // view.scene.AddDefaultLights();
    };

    this.setupTracer = () => {
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
			iterations: targetIterations
		});

		updateRenderJobs();

		traceManager.updatePixels = updatePixelsRect.bind(this);
		traceManager.updateIndicator = updateIndicator.bind(this);

		if(typeof editor != "undefined"){
			editor.signals.cameraChanged.add(this.onCameraChange);
        }

	};
	let timeoutId = 0;
    this.onCameraChange = () => {
		clearCanvas();
		this.updateCamera(this.threejsCamera);
		canvas.style.display = "none";

		if (traceManager) {
			traceManager.stop();
			traceManager.clear();
		}
		clearTimeout(timeoutId);
		timeoutId = setTimeout(() => {
			if (_traceState) {
				traceManager.restart();
			}
			if(_viewState) {
				canvas.style.display = "";
			}
		}, 500);
    };

	this.updateCamera = (camera) => {
		if (view) {
			let ratio1 = width / webglWidth;
			let ratio2 = height / webglHeight;
			let ratio = ratio1 < ratio2 ? ratio1 : ratio2;
			view.updateCamera(camera);
		}
	};

	this.updateScene = (scene) => {
		traceManager.stop(() => {
			view.setScene(scene);
			traceManager.update({scene:view.scene.scenePtr});
			if (_traceState) {
				traceManager.restart();
			}
		});
		traceManager.clear();
    };

    function updateRenderJobs(){

        traceManager.clearJobs();

        let widthRemainder = width % bucketSize;
		let heightRemainder = height % bucketSize;
		let col = Math.ceil(width / bucketSize);
		let row = Math.ceil(height / bucketSize);

		for (let j = 0; j < row; j++) {

		    let h = j == row - 1 ? heightRemainder : bucketSize;

			for (let i = 0; i < col; i++) {

			    let w = i == col - 1 ? widthRemainder : bucketSize;

				traceManager.add(
					new XRAY.TraceJob({
						id: j + "_" + i,
						blockIterations: blockIterations,
						width: w,
						height: h,
						xoffset: i * bucketSize,
						yoffset: j * bucketSize
					})
				);

			}

		}

    }

	let updateRenderer = () => {

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

			updateRenderJobs();

			traceManager.update({
				width: width,
				height: height
			});
		}

		this.updateCamera(this.threejsCamera);
	};

	let clearCanvas = () => {

		let data = imageData.data;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {

				let i = y * (width * 4) + (x * 4);
				data[i] = 0;
				data[i + 1] = 0;
				data[i + 2] = 0;
				data[i + 3] = 255;
			}
		}
		context.putImageData(imageData, 0, 0);
	};

	let updatePixelsRect = (rect, pixels) => {
		let data = imageData.data;
		for (let y = rect.yoffset; y < rect.yoffset + rect.height; y++) {
			for (let x = rect.xoffset; x < rect.xoffset + rect.width; x++) {

				let i = y * (width * 4) + (x * 4);
				let pi = y * (width * 3) + (x * 3);
				data[i] = pixels[pi];
				data[i + 1] = pixels[pi + 1];
				data[i + 2] = pixels[pi + 2];
				data[i + 3] = 255;
			}
		}
		context.putImageData(imageData, 0, 0);
	};

	let updateIndicator = (rect) => {

		let color = yellow;

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
	};

	let fillRect = (rect, color) => {
		let data = imageData.data;
		for (let y = rect.y; y < rect.y + rect.height; y++) {
			for (let x = rect.x; x < rect.x + rect.width; x++) {

				let i = y * (width * 4) + (x * 4);
				data[i] = color.r * 255;
				data[i + 1] = color.g * 255;
				data[i + 2] = color.b * 255;
				data[i + 3] = 255;
			}
		}
		//context.putImageData(imageData, 0, 0);
	};

	let yellow = {r:1, g:186/255, b:27/255};

	function randomColor() {
		return { r: Math.random(), g: Math.random(), b: Math.random() };
	}

	//Override threads for debugging
	XRAY.ThreadPool.overrideMaxThreads = 7;
	initialize();

};

Object.assign(THREE.XRayRenderer.prototype, THREE.WebGLRenderer.prototype);
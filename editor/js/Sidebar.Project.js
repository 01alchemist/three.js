/**
 * @author mrdoob / http://mrdoob.com/
 */

Sidebar.Project = function ( editor ) {

	var config = editor.config;
	var signals = editor.signals;
	var strings = editor.strings;

	var rendererTypes = {

		'WebGLRenderer': THREE.WebGLRenderer,
		'SVGRenderer': THREE.SVGRenderer,
		'SoftwareRenderer': THREE.SoftwareRenderer,
		'RaytracingRenderer': THREE.RaytracingRenderer,
		'WebGL+XRay': THREE.XRayRenderer

	};

	var container = new UI.Panel();
	container.setBorderTop( '0' );
	container.setPaddingTop( '20px' );

	// Title

	var titleRow = new UI.Row();
	var title = new UI.Input( config.getKey( 'project/title' ) ).setLeft( '100px' ).onChange( function () {

		config.setKey( 'project/title', this.getValue() );

	} );

	titleRow.add( new UI.Text( strings.getKey( 'sidebar/project/title' ) ).setWidth( '90px' ) );
	titleRow.add( title );

	container.add( titleRow );

	// Editable

	var editableRow = new UI.Row();
	var editable = new UI.Checkbox( config.getKey( 'project/editable' ) ).setLeft( '100px' ).onChange( function () {

		config.setKey( 'project/editable', this.getValue() );

	} );

	editableRow.add( new UI.Text( strings.getKey( 'sidebar/project/editable' ) ).setWidth( '90px' ) );
	editableRow.add( editable );

	container.add( editableRow );

	// VR

	var vrRow = new UI.Row();
	var vr = new UI.Checkbox( config.getKey( 'project/vr' ) ).setLeft( '100px' ).onChange( function () {

		config.setKey( 'project/vr', this.getValue() );

	} );

	vrRow.add( new UI.Text( strings.getKey( 'sidebar/project/vr' ) ).setWidth( '90px' ) );
	vrRow.add( vr );

	container.add( vrRow );

	// Renderer

	var options = {};

	for ( var key in rendererTypes ) {

		if ( key.indexOf( 'WebGL' ) >= 0 && System.support.webgl === false ) continue;

		options[ key ] = key;

	}

	var rendererTypeRow = new UI.Row();
	var rendererType = new UI.Select().setOptions( options ).setWidth( '150px' ).onChange( function () {

		var value = this.getValue();

		config.setKey( 'project/renderer', value );

		updateRenderer();

	} );

	rendererTypeRow.add( new UI.Text( strings.getKey( 'sidebar/project/renderer' ) ).setWidth( '90px' ) );
	rendererTypeRow.add( rendererType );

	container.add( rendererTypeRow );

	if ( config.getKey( 'project/renderer' ) !== undefined ) {

		rendererType.setValue( config.getKey( 'project/renderer' ) );

	}

	// Renderer / Antialias

	var rendererPropertiesRow = new UI.Row().setMarginLeft( '90px' );

	var rendererAntialias = new UI.THREE.Boolean( config.getKey( 'project/renderer/antialias' ), strings.getKey( 'sidebar/project/antialias' ) ).onChange( function () {

		config.setKey( 'project/renderer/antialias', this.getValue() );
		updateRenderer();

	} );
	rendererPropertiesRow.add( rendererAntialias );

	// Renderer / Shadows

	var rendererShadows = new UI.THREE.Boolean( config.getKey( 'project/renderer/shadows' ), strings.getKey( 'sidebar/project/shadows' ) ).onChange( function () {

		config.setKey( 'project/renderer/shadows', this.getValue() );
		updateRenderer();

	} );
	rendererPropertiesRow.add( rendererShadows );

	container.add( rendererPropertiesRow );

    // XRay toggle

    var xrayRow = new UI.Row();
    config.setKey( 'project/xray-gi-view', false);
    var xray = new UI.THREE.Boolean( config.getKey( 'project/xray-gi-view' ), "View" ).onChange( function () {

        config.setKey( 'project/xray-gi-view', this.getValue() );
        signals.xrayViewStateChanged.dispatch(this.getValue());

    } );

    config.setKey( 'project/xray-gi-raytrace', false);
    var raytrace = new UI.THREE.Boolean( config.getKey( 'project/xray-gi-raytrace' ), "Trace" ).onChange( function () {

        config.setKey( 'project/xray-gi-raytrace', this.getValue() );
        signals.xrayTraceStateChanged.dispatch(this.getValue());

    } );

    xrayRow.add( new UI.Text( 'XRAY' ).setWidth( '90px' ) );
    xrayRow.add( xray );
    xrayRow.add( raytrace );

    container.add( xrayRow );

    // XRay reload

    var xrayUpdateRow = new UI.Row();
    var xrayUpdate = new UI.Button( "Update scene" ).setLeft( '95px' ).onClick( function () {

        signals.xrayUpdateScene.dispatch(true);

    } );

    xrayUpdateRow.add( xrayUpdate );

    container.add( xrayUpdateRow );

	//

	function updateRenderer() {

		createRenderer( rendererType.getValue(), rendererAntialias.getValue() );

	}

	function createRenderer( type, antialias, shadows ) {

		rendererPropertiesRow.setDisplay( type === 'WebGLRenderer' ? '' : 'none' );
		xrayRow.setDisplay( type === 'WebGL+XRay' ? '' : 'none' );

		type = rendererTypes[ type ] === undefined ? 'WebGLRenderer' : type;

		var renderer = new rendererTypes[ type ]( { antialias: antialias } );

		if ( shadows && renderer.shadowMap ) {

			renderer.shadowMap.enabled = true;
			// renderer.shadowMap.type = THREE.PCFSoftShadowMap;

		}

		signals.rendererChanged.dispatch( renderer );

	}

	createRenderer( config.getKey( 'project/renderer' ), config.getKey( 'project/renderer/antialias' ), config.getKey( 'project/renderer/shadows' ) );

	return container;

};

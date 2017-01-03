var XRAY = XRAY || {};
(function TextureUtils(XRAY) {

    var ctx = null;

    function create2dDrawingContext(){
        var canvas = document.createElement("canvas");
        canvas.width = 4096;
        canvas.height = 4096;
        ctx = canvas.getContext("2d");
    }

    var TextureUtils = {};

    TextureUtils.getImageData = function(image){
        if(!ctx){
            create2dDrawingContext();
        }
        ctx.drawImage(image, 0, 0);
        let pixels = ctx.getImageData(0, 0, image.width, image.height).data;
        return pixels;
    }

    XRAY.TextureUtils = TextureUtils
})(XRAY);

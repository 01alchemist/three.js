var XRAY = XRAY || {};
(function TextureUtils(XRAY) {

    let ctx = null;

    function create2dDrawingContext(){
        let canvas = document.createElement("canvas");
        canvas.width = 4096;
        canvas.height = 4096;
        ctx = canvas.getContext("2d");
    }

    let TextureUtils = {};

    TextureUtils.getImageData = function(image){
        if(!ctx){
            create2dDrawingContext();
        }
        if(ctx && image instanceof HTMLImageElement) {
            if(image.width > 0 && image.height > 0){
                ctx.drawImage(image, 0, 0);
                let pixels = ctx.getImageData(0, 0, image.width, image.height).data;
                return pixels;
            }
        }
        return null;
    };

    XRAY.TextureUtils = TextureUtils
})(XRAY);

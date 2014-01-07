goog.provide('ol.renderer.canvas.VectorLayer');

goog.require('goog.asserts');
goog.require('goog.events');
goog.require('goog.events.EventType');
goog.require('goog.functions');
goog.require('ol.ViewHint');
goog.require('ol.extent');
goog.require('ol.feature');
goog.require('ol.layer.Vector');
goog.require('ol.render.canvas.ReplayGroup');
goog.require('ol.renderer.canvas.Layer');
goog.require('ol.renderer.vector');
goog.require('ol.source.Vector');
goog.require('ol.style.ImageState');



/**
 * @constructor
 * @extends {ol.renderer.canvas.Layer}
 * @param {ol.renderer.Map} mapRenderer Map renderer.
 * @param {ol.layer.Vector} vectorLayer Vector layer.
 */
ol.renderer.canvas.VectorLayer = function(mapRenderer, vectorLayer) {

  goog.base(this, mapRenderer, vectorLayer);

  /**
   * @private
   * @type {boolean}
   */
  this.dirty_ = false;

  /**
   * @private
   * @type {ol.Extent}
   */
  this.frameStateExtent_ = ol.extent.createEmpty();

  /**
   * @private
   * @type {number}
   */
  this.renderedRevision_ = -1;

  /**
   * @private
   * @type {number}
   */
  this.renderedResolution_ = NaN;

  /**
   * @private
   * @type {number}
   */
  this.renderedRotation_ = NaN;

  /**
   * @private
   * @type {ol.Extent}
   */
  this.renderedExtent_ = ol.extent.createEmpty();

  /**
   * @private
   * @type {ol.render.canvas.ReplayGroup}
   */
  this.replayGroup_ = null;

};
goog.inherits(ol.renderer.canvas.VectorLayer, ol.renderer.canvas.Layer);


/**
 * @inheritDoc
 */
ol.renderer.canvas.VectorLayer.prototype.composeFrame =
    function(frameState, layerState, context) {

  var transform = this.getTransform(frameState);

  this.dispatchPreComposeEvent(context, frameState, transform);

  var replayGroup = this.replayGroup_;
  if (!goog.isNull(replayGroup)) {
    var renderGeometryFunction = this.getRenderGeometryFunction_();
    goog.asserts.assert(goog.isFunction(renderGeometryFunction));
    context.globalAlpha = layerState.opacity;
    replayGroup.replay(
        context, frameState.extent, transform, renderGeometryFunction);
  }

  this.dispatchPostComposeEvent(context, frameState, transform);

};


/**
 * @inheritDoc
 */
ol.renderer.canvas.VectorLayer.prototype.forEachFeatureAtPixel =
    function(pixel, callback, opt_obj) {
  if (goog.isNull(this.replayGroup_)) {
    return undefined;
  } else {
    goog.asserts.assert(!ol.extent.isEmpty(this.frameStateExtent_));
    goog.asserts.assert(!isNaN(this.renderedResolution_));
    goog.asserts.assert(!isNaN(this.renderedRotation_));
    var coordinate = this.getMap().getCoordinateFromPixel(pixel);
    var layer = this.getLayer();
    var renderGeometryFunction = this.getRenderGeometryFunction_();
    goog.asserts.assert(goog.isFunction(renderGeometryFunction));
    return this.replayGroup_.forEachGeometryAtCoordinate(this.frameStateExtent_,
        this.renderedResolution_, this.renderedRotation_, coordinate,
        renderGeometryFunction,
        /**
         * @param {ol.geom.Geometry} geometry Geometry.
         * @param {Object} data Data.
         */
        function(geometry, data) {
          var feature = /** @type {ol.Feature} */ (data);
          goog.asserts.assert(goog.isDef(feature));
          return callback.call(opt_obj, feature, layer);
        });
  }
};


/**
 * @private
 * @return {function(ol.geom.Geometry): boolean|undefined} Render geometry
 *     function.
 */
ol.renderer.canvas.VectorLayer.prototype.getRenderGeometryFunction_ =
    function() {
  var vectorLayer = this.getLayer();
  goog.asserts.assertInstanceof(vectorLayer, ol.layer.Vector);
  var renderGeometryFunction = vectorLayer.getRenderGeometryFunction();
  if (!goog.isDef(renderGeometryFunction)) {
    renderGeometryFunction = goog.functions.TRUE;
  }
  return renderGeometryFunction;
};


/**
 * Handle changes in image style state.
 * @param {goog.events.Event} event Image style change event.
 * @private
 */
ol.renderer.canvas.VectorLayer.prototype.handleImageStyleChange_ =
    function(event) {
  var imageStyle = /** @type {ol.style.Image} */ (event.target);
  if (imageStyle.getImageState() == ol.style.ImageState.LOADED) {
    this.renderIfReadyAndVisible();
  }
};


/**
 * @inheritDoc
 */
ol.renderer.canvas.VectorLayer.prototype.prepareFrame =
    function(frameState, layerState) {

  var vectorLayer = this.getLayer();
  goog.asserts.assertInstanceof(vectorLayer, ol.layer.Vector);
  var vectorSource = vectorLayer.getSource();
  goog.asserts.assertInstanceof(vectorSource, ol.source.Vector);

  this.updateAttributions(
      frameState.attributions, vectorSource.getAttributions());
  this.updateLogos(frameState, vectorSource);

  if (!this.dirty_ && (frameState.viewHints[ol.ViewHint.ANIMATING] ||
      frameState.viewHints[ol.ViewHint.INTERACTING])) {
    return;
  }

  var frameStateExtent = frameState.extent;
  var frameStateResolution = frameState.view2DState.resolution;
  var pixelRatio = frameState.devicePixelRatio;

  this.frameStateExtent_ = frameStateExtent;

  if (!this.dirty_ &&
      this.renderedResolution_ == frameStateResolution &&
      this.renderedRevision_ == vectorSource.getRevision() &&
      ol.extent.containsExtent(this.renderedExtent_, frameStateExtent)) {
    return;
  }

  var extent = this.renderedExtent_;
  var xBuffer = ol.extent.getWidth(frameStateExtent) / 4;
  var yBuffer = ol.extent.getHeight(frameStateExtent) / 4;
  extent[0] = frameStateExtent[0] - xBuffer;
  extent[1] = frameStateExtent[1] - yBuffer;
  extent[2] = frameStateExtent[2] + xBuffer;
  extent[3] = frameStateExtent[3] + yBuffer;

  // FIXME dispose of old replayGroup in post render
  goog.dispose(this.replayGroup_);
  this.replayGroup_ = null;

  this.dirty_ = false;

  var styleFunction = vectorLayer.getStyleFunction();
  if (!goog.isDef(styleFunction)) {
    styleFunction = ol.feature.defaultStyleFunction;
  }
  var tolerance = frameStateResolution / (2 * pixelRatio);
  var replayGroup = new ol.render.canvas.ReplayGroup(pixelRatio, tolerance);
  vectorSource.forEachFeatureInExtent(extent,
      /**
       * @param {ol.Feature} feature Feature.
       */
      function(feature) {
        this.dirty_ = this.dirty_ ||
            this.renderFeature(feature, frameStateResolution, pixelRatio,
                styleFunction, replayGroup);
      }, this);
  replayGroup.finish();

  this.renderedResolution_ = frameStateResolution;
  this.renderedRevision_ = vectorSource.getRevision();
  this.renderedRotation_ = frameState.view2DState.rotation;
  if (!replayGroup.isEmpty()) {
    this.replayGroup_ = replayGroup;
  }

};


/**
 * @param {ol.Feature} feature Feature.
 * @param {number} resolution Resolution.
 * @param {number} pixelRatio Pixel ratio.
 * @param {ol.feature.StyleFunction} styleFunction Style function.
 * @param {ol.render.canvas.ReplayGroup} replayGroup Replay group.
 * @return {boolean} `true` if an image is loading.
 */
ol.renderer.canvas.VectorLayer.prototype.renderFeature =
    function(feature, resolution, pixelRatio, styleFunction, replayGroup) {
  var loading = false;
  var styles = styleFunction(feature, resolution);
  // FIXME if styles is null, should we use the default style?
  if (!goog.isDefAndNotNull(styles)) {
    return false;
  }
  // simplify to a tolerance of half a device pixel
  var squaredTolerance =
      resolution * resolution / (4 * pixelRatio * pixelRatio);
  var i, ii, style, imageStyle, imageState;
  for (i = 0, ii = styles.length; i < ii; ++i) {
    style = styles[i];
    imageStyle = style.getImage();
    if (!goog.isNull(imageStyle)) {
      if (imageStyle.getImageState() == ol.style.ImageState.IDLE) {
        goog.events.listenOnce(imageStyle, goog.events.EventType.CHANGE,
            this.handleImageStyleChange_, false, this);
        imageStyle.load();
      } else if (imageStyle.getImageState() == ol.style.ImageState.LOADED) {
        ol.renderer.vector.renderFeature(
            replayGroup, feature, style, squaredTolerance, feature);
      }
      goog.asserts.assert(
          imageStyle.getImageState() != ol.style.ImageState.IDLE);
      loading = imageStyle.getImageState() == ol.style.ImageState.LOADING;
    } else {
      ol.renderer.vector.renderFeature(
          replayGroup, feature, style, squaredTolerance, feature);
    }
  }
  return loading;
};
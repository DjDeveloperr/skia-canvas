"use strict"

const fs = require('fs'),
      {EventEmitter} = require('events'),
      {inspect} = require('util'),
      {extname} = require('path'),
      glob = require('glob').sync,
      get = require('simple-get'),
      REPR = inspect.custom

const crate = require('./v6'),
      geometry = require('./geometry'),
      {parseFont, parseVariant, parseFilter} = require('./parse')

//
// Neon <-> Node interface
//

const ø = Symbol.for('📦'), // the attr containing the boxed struct
      core = (obj) => (obj||{})[ø] // dereference the boxed struct

class RustClass{
  alloc(...args){
    this.init('new', ...args)
  }

  init(fn, ...args){
    let create = crate[`${this.constructor.name}_${fn}`]
    hidden(this, ø, create(null, ...args))
  }

  hatch(boxed, ...args){
    return Object.assign(new this.constructor(...args), {[ø]:boxed})
  }

  cache(verb, key, val){
    if (verb=='set') this[Symbol.for(key)] = val
    else if (verb=='get') return this[Symbol.for(key)]
  }

  ƒ(fn, ...args){
    let method = crate[`${this.constructor.name}_${fn}`]
    return method(this[ø], ...args);
  }
}

// shorthand for attaching read-only attributes
const readOnly = (obj, attr, value) => {
  if (typeof attr=='object'){
    for (var k in attr) readOnly(obj, k, attr[k])
  }else{
    Object.defineProperty(obj, attr, {value, writable:false, enumerable:true})
  }
}

const hidden = (obj, attr, value) => {
  Object.defineProperty(obj, attr, {value, writable:false, enumerable:false})
}


// convert arguments list to a string of type abbreviations
function signature(args){
  return args.map(v => (Array.isArray(v) ? 'a' : {string:'s', number:'n', object:'o'}[typeof v] || 'x')).join('')
}

//
// Helpers to reconcile Skia and DOMMatrix’s disagreement about row/col orientation
//

function toSkMatrix(jsMatrix){
  if (Array.isArray(jsMatrix)){
    var [a, b, c, d, e, f] = jsMatrix
  }else{
    var {a, b, c, d, e, f} = jsMatrix
  }
  return [a, c, e, b, d, f]
}

function fromSkMatrix(skMatrix){
  // TBD: how/if to map the perspective terms
  let [a, c, e, b, d, f, p0, p1, p2] = skMatrix
  return new geometry.DOMMatrix([a, b, c, d, e, f])
}

//
// Mime type <-> File extension mappings
//

let png = "image/png",
    jpg = "image/jpeg",
    jpeg = "image/jpeg",
    pdf = "application/pdf",
    svg = "image/svg+xml",
    gif = "image/gif";

function toMime(ext){
  return {
    png, jpg, jpeg, gif, pdf, svg
  }[(ext||'').replace(/^\./, '').toLowerCase()]
}

function fromMime(mime){
  return {
    [png]: "png", [jpg]: "jpg", [gif]: "gif", [pdf]: "pdf", [svg]: "svg"
  }[mime]
}

const toFormat = str => fromMime(toMime(str) || str),
      toString = val => typeof val=='string' ? val : new String(val).toString();

//
// The Canvas API
//

class Canvas extends RustClass{
  static parent = new WeakMap()
  static contexts = new WeakMap()

  constructor(width, height){
    super().alloc()
    let ctx = new CanvasRenderingContext2D(core(this))
    Canvas.parent.set(ctx, this)
    Canvas.contexts.set(this, [ctx])
    Object.assign(this, {width, height})
  }

  getContext(kind){
    return (kind=="2d") ? Canvas.contexts.get(this)[0] : null
  }

  get width(){ return this.ƒ('get_width') }
  set width(w){
    let ctx = Canvas.contexts.get(this)[0]
    this.ƒ('set_width', (typeof w=='number' && !Number.isNaN(w) && w>=0) ? w : 300)
    ctx.ƒ('resetSize', core(this))
  }

  get height(){ return this.ƒ('get_height') }
  set height(h){
    let ctx = Canvas.contexts.get(this)[0]
    this.ƒ('set_height', h = (typeof h=='number' && !Number.isNaN(h) && h>=0) ? h : 150)
    ctx.ƒ('resetSize', core(this))
  }

  newPage(width, height){
    let ctx = new CanvasRenderingContext2D(core(this))
    Canvas.parent.set(ctx, this)
    Canvas.contexts.get(this).unshift(ctx)
    if (arguments.length==2){
      Object.assign(this, {width, height})
    }
    return ctx
  }

  get pages(){
    return Canvas.contexts.get(this).slice().reverse()
  }

  get png(){ return this.toBuffer("png") }
  get jpg(){ return this.toBuffer("jpg") }
  get pdf(){ return this.toBuffer("pdf") }
  get svg(){ return this.toBuffer("svg") }

  saveAs(filename, {format, quality=100}={}){
    var seq
    filename = filename.replace(/{(\d*)}/g, (_, pad) => {
      pad = parseInt(pad, 10)
      seq = isFinite(pad) ? pad : isFinite(seq) ? seq : -1
      return "{}"
    })

    let ext = format || extname(filename),
        fmt = toFormat(ext);

    if(!ext){
      throw new Error(`Cannot determine image format (use a filename extension or 'format' argument)`)
    }if (!fmt){
      throw new Error(`Unsupported file format "${ext}" (expected "png", "jpg", "pdf", or "svg")`)
    }
    this.ƒ("saveAs", filename, seq, fmt, quality, Canvas.contexts.get(this).map(core))
  }

  toBuffer(extension, {format="png", quality=100, page}={}){
    ({format, quality, page} = Object.assign(
      {format, quality, page},
      typeof extension == 'string' ? {format:extension}
    : typeof extension == 'object' ? extension
    : {}
    ));

    let fmt = toFormat(format),
        pp = this.pages.length,
        idx = page >= 0 ? pp - page
            : page < 0 ? pp + page
            : undefined

    if (!fmt){
      throw new Error(`Unsupported file format "${format}" (expected "png", "jpg", "pdf", or "svg")`)
    }else if (isFinite(idx) && idx < 0 || idx >= pp){
      throw new RangeError(
        pp == 1 ? `Canvas only has a ‘page 1’ (${page} is out of bounds)`
                : `Canvas has pages 1–${pp} (${page} is out of bounds)`
      )
    }

    return this.ƒ("toBuffer", fmt, quality, idx, Canvas.contexts.get(this).map(core))
  }

  toDataURL(extension, {format="png", quality=100, page}={}){
    ({format, quality, page} = Object.assign(
      {format, quality, page},
      typeof extension == 'string' ? {format:extension}
    : typeof extension == 'object' ? extension
    : {}
    ));

    let fmt = toFormat(format),
        mime = toMime(fmt),
        buffer = this.toBuffer({format, quality, page});
    return `data:${mime};base64,${buffer.toString('base64')}`
  }

  [REPR](depth, options) {
    let {width, height} = this
    return `Canvas ${inspect({width, height}, options)}`
  }

  view(){
    return GL.view(this)
  }
}

class Window extends EventEmitter{
  constructor(canvas, {title="Skia Canvas", fullscreen=false}={}){
    canvas = (canvas instanceof Canvas) ? canvas : new Canvas(300, 150)
    let {width, height} = canvas,
        state = {fullscreen, active:false, loop:undefined}
    Object.assign(super(), {canvas, width, height, title, state})
  }

  display(){
    let response = []
    const dispatch = (...payload) => {
      let [x, y, width, height, fullscreen, input, keyEvent, keyInfo, mouseEvent, mouseX, mouseY]  = payload

      if (x!==undefined){
        let type = 'move'
        Object.assign(this, {x, y})
        this.emit(type, {type, x, y})
      }

      if (width!==undefined){
        let type = 'resize'
        Object.assign(this, {width, height})
        this.emit(type, {type, width, height})
      }

      if (fullscreen!==undefined){
        let type = 'fullscreen'
        this.state.fullscreen = fullscreen
        this.emit(type, {type, fullscreen})
      }

      if (input!==undefined){
        let type = 'input'
        this.emit(type, {type, char:input, code:input.charCodeAt()})
      }

      if (keyEvent!==undefined){
        let type = keyEvent
        let [key, code, repeat, altKey, ctrlKey, metaKey, shiftKey] = keyInfo
        this.emit(type, {type, key, code, repeat, altKey, ctrlKey, metaKey, shiftKey})
      }

      if (mouseEvent!==undefined){
        this.emit(mouseEvent)
      }

      if (mouseX!==undefined){
        let type = 'mousemove'
        this.emit(type, {type, x:mouseX, y:mouseY})
      }

      response.splice(0, response.length,
        core(Canvas.contexts.get(this.canvas)[0]),
        this.title,
        this.state.active,
        this.state.fullscreen,
        this.state.loop,
        this.x,
        this.y,
        this.width,
        this.height
      )
      return response
    }

    const animate = (frame) => {
      this.emit("frame", frame)
      response.splice(0, response.length,
        core(Canvas.contexts.get(this.canvas)[0]),
        this.state.active,
        this.state.loop
      )
      return response
    }

    if (!this.state.active){
      if (this.state.loop===undefined) this.state.loop = this.listenerCount("frame") > 0
      this.state.active = true
      // this call will block until the window is closed, but events from the window will still be dispatched
      crate.display(core(Canvas.contexts.get(this.canvas)[0]), this.title, dispatch, animate, this.state.loop)
      this.state.active = false
    }
  }

  loop(enabled){
    this.state.loop = !!enabled
    return !!this.state.loop
  }

  fullscreen(mode){
    this.state.fullscreen = arguments.length ? !!mode : !this.state.fullscreen
    return this.state.fullscreen
  }

  close(){
    this.state.active = false
  }

}

class CanvasGradient extends RustClass{
  constructor(style, ...coords){
    style = (style || "").toLowerCase()
    if (['linear', 'radial', 'conic'].includes(style)) super().init(style, ...coords)
    else throw new Error(`Function is not a constructor (use CanvasRenderingContext2D's "createConicGradient", "createLinearGradient", and "createRadialGradient" methods instead)`)
  }

  addColorStop(offset, color){
    if (offset>=0 && offset<=1) this.ƒ('addColorStop', offset, color)
    else throw new Error("Color stop offsets must be between 0.0 and 1.0")
  }

  [REPR](depth, options) {
    return `CanvasGradient (${this.ƒ("repr")})`
  }
}

class CanvasPattern extends RustClass{
  constructor(src, repeat){
    if (src instanceof Image){
      super().init('from_image', core(src), repeat)
    }else if (src instanceof Canvas){
      let ctx = Canvas.contexts.get(src)[0]
      super().init('from_canvas', core(ctx), repeat)
    }else{
      throw new Error("CanvasPatterns require a source Image or a Canvas")
    }
  }

  setTransform(matrix){
    if (arguments.length>1) matrix = [...arguments]
    this.ƒ('setTransform', toSkMatrix(matrix))
  }

  [REPR](depth, options) {
    return `CanvasPattern (${this.ƒ("repr")})`
  }
}

class CanvasRenderingContext2D extends RustClass{
  constructor(canvas){
    try{
      super().alloc(canvas)
    }catch(e){
      throw new TypeError(`Function is not a constructor (use Canvas's "createContext" method instead)`)
    }
  }

  get canvas(){ return Canvas.parent.get(this) }


  // -- grid state ------------------------------------------------------------
  save(){ this.ƒ('save') }
  restore(){ this.ƒ('restore') }

  get currentTransform(){ return fromSkMatrix( this.ƒ('get_currentTransform') ) }
  set currentTransform(matrix){  this.ƒ('set_currentTransform', toSkMatrix(matrix) ) }

  getTransform(){ return this.currentTransform }
  setTransform(matrix){
    this.currentTransform = arguments.length > 1 ? [...arguments] : matrix
  }
  transform(...terms){ this.ƒ('transform', ...terms)}
  translate(x, y){ this.ƒ('translate', x, y)}
  scale(x, y){ this.ƒ('scale', x, y)}
  rotate(angle){ this.ƒ('rotate', angle)}
  resetTransform(){ this.ƒ('resetTransform')}

  // -- bézier paths ----------------------------------------------------------
  beginPath(){ this.ƒ('beginPath') }
  rect(x, y, width, height){ this.ƒ('rect', ...arguments) }
  arc(x, y, radius, startAngle, endAngle, isCCW){ this.ƒ('arc', ...arguments) }
  ellipse(x, y, xRadius, yRadius, rotation, startAngle, endAngle, isCCW){ this.ƒ('ellipse', ...arguments) }
  moveTo(x, y){ this.ƒ('moveTo', x, y) }
  lineTo(x, y){ this.ƒ('lineTo', x, y) }
  arcTo(x1, y1, x2, y2, radius){ this.ƒ('arcTo', ...arguments) }
  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y){ this.ƒ('bezierCurveTo', ...arguments) }
  quadraticCurveTo(cpx, cpy, x, y){ this.ƒ('quadraticCurveTo', ...arguments) }
  closePath(){ this.ƒ('closePath') }
  isPointInPath(x, y){ return this.ƒ('isPointInPath', x, y) }
  isPointInStroke(x, y){ return this.ƒ('isPointInStroke', x, y) }

  // -- using paths -----------------------------------------------------------
  fill(path, rule){
    if (path instanceof Path2D) this.ƒ('fill', core(path), rule)
    else this.ƒ('fill', path) // 'path' is the optional winding-rule
  }

  stroke(path, rule){
    if (path instanceof Path2D) this.ƒ('stroke', core(path), rule)
    else this.ƒ('stroke', path) // 'path' is the optional winding-rule
  }

  clip(path, rule){
    if (path instanceof Path2D) this.ƒ('clip', core(path), rule)
    else this.ƒ('clip', path) // 'path' is the optional winding-rule
  }

  // -- shaders ---------------------------------------------------------------
  createPattern(image, repetition){ return new CanvasPattern(...arguments) }
  createLinearGradient(x0, y0, x1, y1){
    return new CanvasGradient("Linear", ...arguments)
  }
  createRadialGradient(x0, y0, r0, x1, y1, r1){
    return new CanvasGradient("Radial", ...arguments)
  }
  createConicGradient(startAngle, x, y){
    return new CanvasGradient("Conic", ...arguments)
  }

  // -- fill & stroke ---------------------------------------------------------
  fillRect(x, y, width, height){ this.ƒ('fillRect', ...arguments) }
  strokeRect(x, y, width, height){ this.ƒ('strokeRect', ...arguments) }
  clearRect(x, y, width, height){ this.ƒ('clearRect', ...arguments) }

  set fillStyle(style){
    let isShader = style instanceof CanvasPattern || style instanceof CanvasGradient,
        [ref, val] = isShader ? [style, core(style)] : [null, style]
    this.cache('set', 'fill', ref)
    this.ƒ('set_fillStyle', val)
  }

  get fillStyle(){
    let style = this.ƒ('get_fillStyle')
    return style===null ? this.cache('get', 'fill') : style
  }

  set strokeStyle(style){
    let isShader = style instanceof CanvasPattern || style instanceof CanvasGradient,
        [ref, val] = isShader ? [style, core(style)] : [null, style]
    this.cache('set', 'stroke', ref)
    this.ƒ('set_strokeStyle', val)
  }

  get strokeStyle(){
    let style = this.ƒ('get_strokeStyle')
    return style===null ? this.cache('get', 'stroke') : style
  }

  // -- line style ------------------------------------------------------------
  getLineDash(){        return this.ƒ("getLineDash") }
  setLineDash(segments){       this.ƒ("setLineDash", segments) }
  get lineCap(){        return this.ƒ("get_lineCap") }
  set lineCap(style){          this.ƒ("set_lineCap", style) }
  get lineDashOffset(){ return this.ƒ("get_lineDashOffset") }
  set lineDashOffset(offset){  this.ƒ("set_lineDashOffset", offset) }
  get lineJoin(){       return this.ƒ("get_lineJoin") }
  set lineJoin(style){         this.ƒ("set_lineJoin", style) }
  get lineWidth(){      return this.ƒ("get_lineWidth") }
  set lineWidth(width){        this.ƒ("set_lineWidth", width) }
  get miterLimit(){     return this.ƒ("get_miterLimit") }
  set miterLimit(limit){       this.ƒ("set_miterLimit", limit) }

  // -- imagery ---------------------------------------------------------------
  get imageSmoothingEnabled(){ return this.ƒ("get_imageSmoothingEnabled")}
  set imageSmoothingEnabled(flag){    this.ƒ("set_imageSmoothingEnabled", !!flag)}
  get imageSmoothingQuality(){ return this.ƒ("get_imageSmoothingQuality")}
  set imageSmoothingQuality(level){   this.ƒ("set_imageSmoothingQuality", level)}
  putImageData(imageData, ...coords){ this.ƒ('putImageData', imageData, ...coords) }
  createImageData(width, height){ return new ImageData(width, height) }

  getImageData(x, y, width, height){
    let w = Math.floor(width),
    h = Math.floor(height),
    buffer = this.ƒ('getImageData', x, y, w, h);
    return new ImageData(w, h, buffer)
  }

  drawImage(image, ...coords){
    if (image instanceof Canvas){
      this.ƒ('drawCanvas', core(Canvas.contexts.get(image)[0]), ...coords)
    }else if (image instanceof Image){
      this.ƒ('drawRaster', core(image), ...coords)
    }else{
      throw new Error("Expected an Image or a Canvas argument")
    }
  }

  // -- typography ------------------------------------------------------------
  get font(){         return this.ƒ('get_font') }
  set font(str){             this.ƒ('set_font', parseFont(str)) }
  get textAlign(){    return this.ƒ("get_textAlign") }
  set textAlign(mode){       this.ƒ("set_textAlign", mode) }
  get textBaseline(){ return this.ƒ("get_textBaseline") }
  set textBaseline(mode){    this.ƒ("set_textBaseline", mode) }
  get direction(){    return this.ƒ("get_direction") }
  set direction(mode){       this.ƒ("set_direction", mode) }

  measureText(text, maxWidth){
    let [metrics, ...lines] = this.ƒ('measureText', toString(text), maxWidth)
    return new TextMetrics(metrics, lines)
  }

  fillText(text, x, y, maxWidth){
    this.ƒ('fillText', toString(text), x, y, maxWidth)
  }

  strokeText(text, x, y, maxWidth){
    this.ƒ('strokeText', toString(text), x, y, maxWidth)
  }

  // -- non-standard typography extensions --------------------------------------------
  get fontVariant(){  return this.ƒ('get_fontVariant') }
  set fontVariant(str){      this.ƒ('set_fontVariant', parseVariant(str)) }
  get textTracking(){ return this.ƒ("get_textTracking") }
  set textTracking(ems){     this.ƒ("set_textTracking", ems) }
  get textWrap(){     return this.ƒ("get_textWrap") }
  set textWrap(flag){        this.ƒ("set_textWrap", !!flag) }

  // -- effects ---------------------------------------------------------------
  get globalCompositeOperation(){ return this.ƒ("get_globalCompositeOperation") }
  set globalCompositeOperation(blend){   this.ƒ("set_globalCompositeOperation", blend) }
  get globalAlpha(){   return this.ƒ("get_globalAlpha") }
  set globalAlpha(alpha){     this.ƒ("set_globalAlpha", alpha) }
  get shadowBlur(){    return this.ƒ("get_shadowBlur") }
  set shadowBlur(level){      this.ƒ("set_shadowBlur", level) }
  get shadowColor(){   return this.ƒ("get_shadowColor") }
  set shadowColor(color){     this.ƒ("set_shadowColor", color) }
  get shadowOffsetX(){ return this.ƒ("get_shadowOffsetX") }
  set shadowOffsetX(x){       this.ƒ("set_shadowOffsetX", x) }
  get shadowOffsetY(){ return this.ƒ("get_shadowOffsetY") }
  set shadowOffsetY(y){       this.ƒ("set_shadowOffsetY", y) }
  get filter(){        return this.ƒ('get_filter') }
  set filter(str){            this.ƒ('set_filter', parseFilter(str)) }



  [REPR](depth, options) {
    let props = [ "canvas", "currentTransform", "fillStyle", "strokeStyle", "font", "fontVariant",
                  "direction", "textAlign", "textBaseline", "textTracking", "textWrap", "globalAlpha",
                  "globalCompositeOperation", "imageSmoothingEnabled", "imageSmoothingQuality", "filter",
                  "shadowBlur", "shadowColor", "shadowOffsetX", "shadowOffsetY", "lineCap", "lineDashOffset",
                  "lineJoin", "lineWidth", "miterLimit" ]
    let info = {}
    if (depth > 0 ){
      for (var prop of props){
        try{ info[prop] = this[prop] }
        catch{ info[prop] = undefined }
      }
    }
    return `CanvasRenderingContext2D ${inspect(info, options)}`
  }
}

const _expand = paths => [paths].flat(2).map(filename => glob(filename)).flat()

class FontLibrary extends RustClass {
  get families(){ return this.ƒ('get_families') }

  has(familyName){ return this.ƒ('has', familyName) }

  family(name){ return this.ƒ('family', name) }

  use(...args){
    let sig = signature(args)
    if (sig=='o'){
      let results = {}
      for (let [alias, paths] of Object.entries(args.shift())){
        results[alias] = this.ƒ("addFamily", alias, _expand(paths))
      }
      return results
    }else if (sig.match(/^s?[as]$/)){
      let fonts = _expand(args.pop())
      let alias = args.shift()
      return this.ƒ("addFamily", alias, fonts)
    }else{
      throw new Error("Expected an array of file paths or an object mapping family names to font files")
    }
  }
}

class Image extends RustClass {
  constructor(){
    super().alloc()
  }

  get complete(){ return this.ƒ('get_complete') }
  get height(){ return this.ƒ('get_height') }
  get width(){ return this.ƒ('get_width') }

  get src(){ return this.ƒ('get_src') }
  set src(src){
    var noop = () => {},
        onload = img => fetch.emit('ok', img),
        onerror = err => fetch.emit('err', err),
        passthrough = fn => arg => { (fn||noop)(arg); delete this._fetch },
        data

    if (this._fetch) this._fetch.removeAllListeners()
    let fetch = this._fetch = new EventEmitter()
        .once('ok', passthrough(this.onload))
        .once('err', passthrough(this.onerror))

    if (Buffer.isBuffer(src)){
      [data, src] = [src, '']
    } else if (typeof src != 'string'){
      return
    } else if (/^\s*data:/.test(src)) {
      // data URI
      let split = src.indexOf(','),
          enc = src.lastIndexOf('base64', split) !== -1 ? 'base64' : 'utf8',
          content = src.slice(split + 1);
      data = Buffer.from(content, enc);
    } else if (/^\s*https?:\/\//.test(src)) {
      // remote URL
      get.concat(src, (err, res, data) => {
        let code = (res || {}).statusCode
        if (err) onerror(err)
        else if (code < 200 || code >= 300) {
          onerror(new Error(`Failed to load image from "${src}" (error ${code})`))
        }else{
          if (this.ƒ("set_data", data)) onload(this)
          else onerror(new Error("Could not decode image data"))
        }
      })
    } else {
      // local file path
      data = fs.readFileSync(src);
    }

    this.ƒ("set_src", src)
    if (data){
      if (this.ƒ("set_data", data)) onload(this)
      else onerror(new Error("Could not decode image data"))
    }

  }

  decode(){
    return this._fetch ? new Promise((res, rej) => this._fetch.once('ok', res).once('err', rej) )
         : this.complete ? Promise.resolve(this)
         : Promise.reject(new Error("Missing Source URL"))
  }

  [REPR](depth, options) {
    let {width, height, complete, src} = this
    options.maxStringLength = src.match(/^data:/) ? 128 : Infinity;
    return `Image ${inspect({width, height, complete, src}, options)}`
  }
}

class ImageData{
  constructor(width, height, data){
    if (arguments[0] instanceof ImageData){
      var {width, height, data} = arguments[0]
    }

    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0){
      throw new Error("ImageData dimensions must be positive integers")
    }

    readOnly(this, "width", width)
    readOnly(this, "height", height)
    readOnly(this, "data", new Uint8ClampedArray(data && data.buffer || width * height * 4))
  }

  [REPR](depth, options) {
    let {width, height, data} = this
    return `ImageData ${inspect({width, height, data}, options)}`
  }
}

class Path2D extends RustClass{
  constructor(source){
    if (source instanceof Path2D) super().init('from_path', core(source))
    else if (typeof source == 'string') super().init('from_svg', source)
    else super().alloc()
  }

  // measure dimensions
  get bounds(){ return this.ƒ('bounds') }

  // concatenation
  addPath(path, matrix){
    if (!(path instanceof Path2D)) throw new Error("Expected a Path2D object")
    if (matrix) matrix = toSkMatrix(matrix)
    this.ƒ('addPath', core(path), matrix)
  }

  // line segments
  moveTo(x, y){ this.ƒ("moveTo", x, y) }
  lineTo(x, y){ this.ƒ("lineTo", x, y) }
  closePath(){ this.ƒ("closePath") }
  arcTo(x1, y1, x2, y2, radius){ this.ƒ("arcTo", ...arguments) }
  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y){ this.ƒ("bezierCurveTo", ...arguments) }
  quadraticCurveTo(cpx, cpy, x, y){ this.ƒ("quadraticCurveTo", ...arguments) }

  // shape primitives
  ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, isCCW){ this.ƒ("ellipse", ...arguments) }
  rect(x, y, width, height){this.ƒ("rect", ...arguments) }
  arc(x, y, radius, startAngle, endAngle){ this.ƒ("arc", ...arguments) }

  // boolean operations
  complement(path){ return this.hatch(this.ƒ("op", core(path), "complement")) }
  difference(path){ return this.hatch(this.ƒ("op", core(path), "difference")) }
  intersect(path){  return this.hatch(this.ƒ("op", core(path), "intersect")) }
  union(path){      return this.hatch(this.ƒ("op", core(path), "union")) }
  xor(path){        return this.hatch(this.ƒ("op", core(path), "xor")) }

  // elide overlaps
  simplify(){       return this.hatch(this.ƒ('simplify')) }
}

class TextMetrics{
  constructor([
    width, left, right, ascent, descent,
    fontAscent, fontDescent, emAscent, emDescent,
    hanging, alphabetic, ideographic
  ], lines){
    readOnly(this, "width", width)
    readOnly(this, "actualBoundingBoxLeft", left)
    readOnly(this, "actualBoundingBoxRight", right)
    readOnly(this, "actualBoundingBoxAscent", ascent)
    readOnly(this, "actualBoundingBoxDescent", descent)
    readOnly(this, "fontBoundingBoxAscent", fontAscent)
    readOnly(this, "fontBoundingBoxDescent", fontDescent)
    readOnly(this, "emHeightAscent", emAscent)
    readOnly(this, "emHeightDescent", emDescent)
    readOnly(this, "hangingBaseline", hanging)
    readOnly(this, "alphabeticBaseline", alphabetic)
    readOnly(this, "ideographicBaseline", ideographic)
    readOnly(this, "lines", lines.map( ([x, y, width, height, baseline, startIndex, endIndex]) => (
      {x, y, width, height, baseline, startIndex, endIndex}
    )))
  }
}


const loadImage = src => new Promise((onload, onerror) =>
  Object.assign(new Image(), {onload, onerror, src})
)

module.exports = {
  Canvas, CanvasGradient, CanvasPattern, CanvasRenderingContext2D,
  TextMetrics, Image, ImageData, Path2D, loadImage, ...geometry,
  FontLibrary:new FontLibrary(), Window
}
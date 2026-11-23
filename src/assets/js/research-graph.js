// An interactive view of the same family records used by the Problem Bank outline.
(function(root){
  'use strict';
  var svgNS = 'http://www.w3.org/2000/svg';
  var kinds = {northstar:'Northstar', moonshot:'Moonshot', problem:'Research problem'};
  var stages = {open:'Open', implemented:'Implemented', checked:'Checked', validated:'Validated'};

  function html(tag, className, text){
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function svg(tag, attrs, text){
    var element = document.createElementNS(svgNS, tag);
    Object.keys(attrs || {}).forEach(function(key){ element.setAttribute(key, String(attrs[key])); });
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function button(caption, action){
    var control = html('button', '', caption);
    control.type = 'button'; control.addEventListener('click', action);
    return control;
  }
  function titleLines(title, measure, limit){
    var words = title.trim().split(/\s+/), lines = [], line = '';
    for (var word of words){
      if (line && measure(line + ' ' + word) > limit){ lines.push(line); line = ''; }
      line += (line ? ' ' : '') + word;
      if (lines.length === 2) break;
    }
    if (line) lines.push(line);
    return lines.slice(0,2).map(function(value, i){
      if (measure(value) <= limit && (i !== 1 || lines.length < 3)) return value;
      while (value && measure(value + '…') > limit) value = value.slice(0,-1);
      return value.trimEnd() + '…';
    });
  }
  function mount(host, options){
    var model = root.BoldResearchGraphModel, family, index, selection = null, query = '', archived = false;
    var projection, camera, drag, hover, focusByKey = false, scale = 1;
    var shell = html('div','rg-shell'), frame = html('div','rg-frame'), canvas = html('div','rg-canvas');
    var chart = svg('svg', {role:'group','aria-label':'Research relationships',preserveAspectRatio:'xMidYMid meet'});
    var defs = svg('defs'), arrow = svg('marker',{id:'rg-contribution-arrow',viewBox:'0 0 9 9',refX:8,refY:4.5,markerWidth:8,markerHeight:8,orient:'auto',markerUnits:'userSpaceOnUse'});
    arrow.append(svg('path',{d:'M1,1 L8,4.5 L1,8 Z',class:'rg-arrow'})); defs.append(arrow);
    chart.setAttribute('tabindex','0');
    chart.setAttribute('aria-description','Use arrow keys to pan. Use plus or minus to zoom and zero to fit the graph.');
    var drawing = svg('g'), notice = html('p','rg-notice'); notice.setAttribute('role','status'); notice.hidden = true;
    chart.append(defs, drawing); canvas.append(chart, notice);
    var controls = html('div','rg-controls'); controls.setAttribute('role','group'); controls.setAttribute('aria-label','Graph controls');
    var overview = button('Overview', function(){ choose(null); }); overview.hidden = true;
    var smaller = button('−',function(){zoom(1/1.45);}), larger = button('+',function(){zoom(1.45);});
    smaller.setAttribute('aria-label','Zoom out'); larger.setAttribute('aria-label','Zoom in');
    smaller.title = 'Zoom out'; larger.title = 'Zoom in';
    var fit = button('Fit', fitGraph); fit.setAttribute('aria-label','Fit graph'); fit.title = 'Fit graph';
    controls.append(overview, smaller, larger, fit); canvas.append(controls);
    var legend = html('div','rg-legend'); legend.setAttribute('aria-label','Graph legend');
    [['northstar','Northstar'],['moonshot','Moonshot'],['problem','Problem'],['contributes_to','Contributes to'],['related_to','Related to']].forEach(function(entry){
      var label = html('span'); var key = html('i','rg-key rg-key-'+entry[0]); key.setAttribute('aria-hidden','true'); label.append(key, document.createTextNode(entry[1])); legend.append(label);
    });
    frame.append(canvas, legend);
    var inspector = html('aside','rg-inspector'); inspector.setAttribute('data-inspector',''); inspector.setAttribute('aria-label','Graph details');
    shell.append(frame, inspector); host.append(shell);
    var measuring = document.createElement('canvas').getContext('2d');
    function measure(text){
      return measuring.measureText(text).width;
    }
    function choose(id){
      if (options && options.onFocus) options.onFocus(id);
      if (selection !== id) setFocus(id);
    }
    function mark(node){
      var attrs = {class:'rg-symbol'};
      if (node.kind === 'moonshot') return svg('path',Object.assign(attrs,{d:'M0,-12 L12,0 L0,12 L-12,0 Z'}));
      return svg('circle',Object.assign(attrs,{r:node.kind === 'northstar' ? 12 : 8}));
    }
    function goButton(node){
      var control = button('', function(event){ focusByKey = event.detail === 0; choose(node.id); });
      control.setAttribute('data-go',node.id);
      var key = html('i','rg-key rg-key-'+node.kind); key.setAttribute('aria-hidden','true');
      control.append(key, document.createTextNode(node.title + (node.archived ? ' (archived)' : ''))); return control;
    }
    function nodeList(section, label, rows){
      if (!rows.length) return;
      var list = html('ul','rg-links'), offset = 0;
      if (label) section.append(html('h4','',label));
      section.append(list);
      var more = button('Show more', function(){ append(); }); more.className = 'rg-more';
      function append(){
        var next = rows.slice(offset,offset+8);
        next.forEach(function(item){ var li = html('li'); li.append(goButton(item)); list.append(li); });
        offset += next.length; more.hidden = offset >= rows.length;
      }
      append(); section.append(more);
    }
    function renderInspector(){
      inspector.replaceChildren();
      if (!index) return;
      if (query){
        var matches = model.search(index,query);
        inspector.append(html('h3','','Search results'));
        if (!matches.length) inspector.append(html('p','','No matching problems or objectives.'));
        else nodeList(inspector, matches.length === 1 ? '1 match' : matches.length+' matches', matches);
        return;
      }
      var node = index.nodes.get(selection);
      if (!node){
        var help = projection && projection.omitted ? 'Showing ' + projection.nodes.length + ' of ' + index.nodes.size + ' items. Search to find another.' : 'Select a node to explore its connections.';
        inspector.append(html('h3','','Research objectives'),html('p','',help));
        nodeList(inspector, 'Objectives', index.ordered.filter(function(n){return n.kind !== 'problem';}));
        if (projection && projection.omitted){
          var visible = new Set(projection.nodes.map(function(n){return n.id;}));
          var others = index.ordered.filter(function(n){return !visible.has(n.id);});
          var additional = html('details','rg-other'); additional.append(html('summary','','Other items (' + others.length + ')'));
          nodeList(additional, '', others); inspector.append(additional);
        }
        return;
      }
      var type = html('div','rg-type'), key = html('i','rg-key rg-key-'+node.kind); key.setAttribute('aria-hidden','true');
      var purpose = node.builds_benchmark ? ' · Benchmark' : '';
      type.append(key, document.createTextNode(kinds[node.kind]+purpose+(node.archived?' · Archived':node.stage && stages[node.stage]?' · '+stages[node.stage]:'')));
      inspector.append(type,html('h3','',node.title));
      var link = html('a','rg-record',node.kind === 'problem' ? 'Open problem' : 'Open in outline');
      link.href = (node.kind === 'problem' ? 'problem.html?problem=' : 'problems.html?objective=')+encodeURIComponent(node.id); inspector.append(link);
      var neighbors = model.neighbors(index,node.id);
      nodeList(inspector,'Contributes to',neighbors.parents); nodeList(inspector,'Contributing problems',neighbors.children); nodeList(inspector,'Related problems',neighbors.related);
      if (!(neighbors.parents.length+neighbors.children.length+neighbors.related.length)) inspector.append(html('p','','No recorded connections.'));
      if (projection && projection.omitted) inspector.append(html('p','rg-small','Select a connection above to continue exploring beyond the visible graph.'));
    }
    function highlight(id){
      hover = id;
      var adjacent = new Set([id]);
      drawing.querySelectorAll('[data-from]').forEach(function(edge){
        var incident = edge.dataset.from === id || edge.dataset.to === id;
        if (incident){ adjacent.add(edge.dataset.from); adjacent.add(edge.dataset.to); }
        edge.classList.toggle('rg-muted', !!id && !incident);
        edge.classList.toggle('rg-incident', incident);
      });
      drawing.querySelectorAll('[data-node-id]').forEach(function(el){ el.classList.toggle('rg-muted', !!id && !adjacent.has(el.dataset.nodeId)); });
    }
    function adjustCamera(){
      if (!camera) return;
      chart.setAttribute('viewBox', [camera.x,camera.y,camera.w,camera.h].join(' '));
      smaller.disabled = scale <= 0.61; larger.disabled = scale >= 4.99;
    }
    function fitGraph(){
      if (!projection) return;
      camera = {x:0,y:0,w:projection.width,h:projection.height}; scale = 1; adjustCamera();
    }
    function zoom(factor){
      if (!camera) return;
      var next = Math.max(.6, Math.min(5,scale*factor)), fraction = scale/next;
      var w = camera.w*fraction, h = camera.h*fraction;
      camera = {x:camera.x+(camera.w-w)/2,y:camera.y+(camera.h-h)/2,w:w,h:h}; scale = next; adjustCamera();
    }
    // On narrow screens keep the marks, tap targets and text at their native size.
    // Preserve the graph's relative positions and limit each label to its available space.
    function sizeForCanvas(view){
      var width = canvas.clientWidth, height = canvas.clientHeight;
      if (width < 1 || height < 1 || width > 510 || !view.nodes.length) return view;
      var xs = view.nodes.map(function(n){return n.x;}), ys = view.nodes.map(function(n){return n.y;});
      var minX = Math.min.apply(null,xs), maxX = Math.max.apply(null,xs);
      var minY = Math.min.apply(null,ys), maxY = Math.max.apply(null,ys);
      var margin = Math.min(82, width * .22);
      var nodes = view.nodes.map(function(n){
        return Object.assign({}, n, {
          x: minX === maxX ? width/2 : margin + (width-2*margin)*(n.x-minX)/(maxX-minX),
          y: minY === maxY ? height/2-12 : 66 + (height-126)*(n.y-minY)/(maxY-minY)
        });
      });
      nodes.forEach(function(n){
        n.labelWidth = Math.min(158, (Math.min(n.x,width-n.x)-5)*2);
        nodes.forEach(function(other){
          if (n !== other && Math.abs(n.y-other.y)<44) n.labelWidth = Math.min(n.labelWidth, Math.max(26, Math.abs(n.x-other.x)-6));
        });
      });
      return Object.assign({}, view, {nodes:nodes,width:width,height:height});
    }
    function draw(){
      drawing.replaceChildren(); hover = null;
      if (!index) return;
      projection = sizeForCanvas(model.project(index,selection));
      measuring.font = '600 13px ' + (getComputedStyle(chart).fontFamily || 'sans-serif');
      var placed = new Map(projection.nodes.map(function(node){return [node.id,node];}));
      var matching = query ? new Set(model.search(index,query).map(function(node){return node.id;})) : null;
      overview.hidden = !selection;
      notice.textContent = !placed.size ? 'No problems or objectives to display.' : '';
      notice.hidden = !!placed.size;
      controls.hidden = !placed.size;
      projection.edges.forEach(function(e){
        var from = placed.get(e.from), to = placed.get(e.to); if (!from || !to) return;
        var dx = to.x-from.x, dy = to.y-from.y, length = Math.hypot(dx,dy); if (!length) return;
        var ux = dx/length, uy = dy/length;
        var r1 = from.kind === 'problem' ? 11 : 15, r2 = to.kind === 'problem' ? 13 : 17;
        var attrs = {d:'M'+(from.x+ux*r1)+','+(from.y+uy*r1)+' L'+(to.x-ux*r2)+','+(to.y-uy*r2), class:'rg-edge', 'data-kind':e.kind, 'data-from':e.from, 'data-to':e.to};
        if (e.kind === 'contributes_to') attrs['marker-end']='url(#rg-contribution-arrow)';
        drawing.append(svg('path', attrs));
      });
      projection.nodes.forEach(function(node){
        var group = svg('g',{class:'rg-node',transform:'translate('+node.x+' '+node.y+')','data-node-id':node.id,'data-kind':node.kind,role:'button',tabindex:0,'aria-pressed':String(node.id===selection),'aria-label':node.title+', '+kinds[node.kind]+(node.archived?', archived':'')});
        group.classList.toggle('rg-match',!!matching && matching.has(node.id));
        group.classList.toggle('rg-no-match',!!matching && !matching.has(node.id));
        group.append(svg('title',{},node.title),svg('circle',{r:23,fill:'transparent'}),svg('circle',{r:20,class:'rg-halo'}),mark(node));
        if (node.kind === 'northstar') group.append(svg('circle',{r:3,class:'rg-core'}));
        var label = svg('text',{y:32,'text-anchor':'middle',class:'rg-label'});
        titleLines(node.title,measure,node.labelWidth || 158).forEach(function(line, idx){label.append(svg('tspan',{x:0,dy:idx?16:0},line));}); group.append(label);
        group.addEventListener('click', function(){choose(node.id);});
        group.addEventListener('keydown',function(event){if (event.key==='Enter' || event.key===' '){event.preventDefault(); focusByKey=true; choose(node.id);}});
        group.addEventListener('pointerenter',function(){highlight(node.id);}); group.addEventListener('pointerleave',function(){if(hover===node.id)highlight(null);});
        group.addEventListener('focus',function(){highlight(node.id);}); group.addEventListener('blur',function(){if(hover===node.id)highlight(null);});
        drawing.append(group);
      });
      fitGraph();
      if (focusByKey){
        focusByKey = false;
        var target = Array.from(drawing.querySelectorAll('[data-node-id]')).find(function(el){return el.dataset.nodeId===selection;});
        if (target) target.focus({preventScroll:true});
      }
    }
    function render(){ draw(); renderInspector(); }
    function reindex(){index = family ? model.build(family,archived) : null; render();}
    function setFocus(id){id = id || null; if (selection!==id){selection=id; render();}}
    chart.addEventListener('pointerdown',function(event){
      if (!camera || event.button !== 0 || !event.isPrimary || event.target.closest('[data-node-id]')) return;
      var matrix=chart.getScreenCTM(); if (!matrix || !matrix.a) return;
      drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:camera.x,top:camera.y,ratio:matrix.a};
      chart.setPointerCapture(event.pointerId); chart.classList.add('rg-dragging');
    });
    chart.addEventListener('pointermove',function(event){
      if (!drag || event.pointerId!==drag.id || !camera) return;
      camera.x=drag.left-(event.clientX-drag.x)/drag.ratio; camera.y=drag.top-(event.clientY-drag.y)/drag.ratio; adjustCamera();
    });
    chart.addEventListener('lostpointercapture',function(){drag=null;chart.classList.remove('rg-dragging');});
    chart.addEventListener('keydown',function(event){
      if (!camera || event.ctrlKey || event.metaKey || event.altKey) return;
      var movement = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
      if (movement){camera.x+=movement[0]*camera.w/8; camera.y+=movement[1]*camera.h/8; adjustCamera();}
      else if (event.key==='+' || event.key==='=') zoom(1.45);
      else if (event.key==='-') zoom(1/1.45);
      else if (event.key==='0') fitGraph();
      else return;
      event.preventDefault();
    });
    var lastWidth = 0, lastHeight = 0;
    function resize(){
      var width=canvas.clientWidth, height=canvas.clientHeight;
      if (!width || !height || (lastWidth===width && lastHeight===height)) return;
      lastWidth=width; lastHeight=height;
      if (index) render();
    }
    if (root.ResizeObserver) new ResizeObserver(resize).observe(canvas);
    return {
      setData:function(value){if(family!==value){family=value;reindex();}},setFocus:setFocus,
      search:function(value){value=String(value||'').trim();if(query!==value){query=value;render();}},
      setArchived:function(value){value=!!value;if(archived!==value){archived=value;reindex();}},
      reset:function(){family=index=projection=camera=null;selection=null;query='';archived=false;drag=null;drawing.replaceChildren();inspector.replaceChildren();notice.hidden=true;controls.hidden=true;},
      resize:resize
    };
  }
  root.BoldResearchGraph={mount:mount};
})(window);

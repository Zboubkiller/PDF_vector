const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');

const xmlData = fs.readFileSync('/tmp/test_catalogue.fodg', 'utf8');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const jsonObj = parser.parse(xmlData);

const document = jsonObj['office:document'];
const body = document['office:body'];
const drawing = body['office:drawing'];
const pages = Array.isArray(drawing['draw:page']) ? drawing['draw:page'] : [drawing['draw:page']];

console.log('Pages:', pages.length);
pages.forEach((page, pIdx) => {
  const frames = page['draw:frame'];
  const framesArr = Array.isArray(frames) ? frames : (frames ? [frames] : []);
  console.log('Page ' + (pIdx + 1) + ': ' + framesArr.length + ' frames');
  
  let sampleCount = 0;
  framesArr.forEach(frame => {
    const textBox = frame['draw:text-box'];
    if (textBox) {
      const ps = textBox['text:p'];
      const pArr = Array.isArray(ps) ? ps : (ps ? [ps] : []);
      pArr.forEach(p => {
        let text = '';
        if (typeof p === 'string') text = p;
        else if (typeof p === 'object') {
          if (p['#text']) text += p['#text'];
          if (p['text:span']) {
            const spans = Array.isArray(p['text:span']) ? p['text:span'] : [p['text:span']];
            spans.forEach(s => {
              if (typeof s === 'string') text += s;
              else if (typeof s === 'object' && s['#text']) text += s['#text'];
            });
          }
        }
        text = text.trim();
        if (text && sampleCount < 5) {
          console.log('   [x=' + frame['@_svg:x'] + ', y=' + frame['@_svg:y'] + '] Text:   + text +  ');
          sampleCount++;
        }
      });
    }
  });
});

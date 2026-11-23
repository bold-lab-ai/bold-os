const fs = require('fs');
const path = require('path');
const vm = require('vm');

// card-model.js, the page's card, copied next to this file on deploy (firebase.json
// predeploy) or read from the site's source when run locally.
let cardModel = null;
function makeRegisteredCard(user, fields, now){
  if (!cardModel) {
    const here = path.join(__dirname, 'card-model.js'), src = path.join(__dirname, '..', 'src', 'assets', 'js', 'card-model.js');
    const ctx = {};
    vm.runInNewContext(fs.readFileSync(fs.existsSync(here) ? here : src, 'utf8'), ctx);
    cardModel = ctx;
  }
  return JSON.parse(JSON.stringify(cardModel.makeRegisteredCard(user, fields, now)));
}

module.exports = makeRegisteredCard;

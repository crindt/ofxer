var spawn = require('child_process').spawn,
child;
var async = require('async')
var classifier = require('classifier')
var _ = require("lodash-node");
var getTransactionClassifier = require(__dirname+'/funcs.js').getTransactionClassifier;
var argv = require("minimist")(
  process.argv.slice(2),
  { string: [ 'b', 'e', 'a' ] }
);
var moment = require('moment');
var amountMeta = require(__dirname+'/funcs.js').amountMeta;
var Xact = require(__dirname+'/funcs.js').Xact;
var stripXact = require(__dirname+'/funcs.js').stripXact;
var doTrain = require(__dirname+'/funcs.js').doTrain;
var saveAllClassifiers = require(__dirname+'/funcs.js').saveAllClassifiers;

var args = ["-f", argv.f, "xml", "reg", argv.a, "-r"];
if ( argv.b ) { args.push("-b");args.push(argv.b) }
if ( argv.e ) { args.push("-e");args.push(argv.e) }

if ( ! argv.key ) {
  throw new Error("GOTTA SPECIFY THE FILE KEY")
}


console.log("ledger ",_.map(args,function(a) { 
  return a.match(/-/) ? a : '"'+a+'"';
}).join(" "))
child = spawn('ledger',args)

var data = ""
var errdata = ""

child.stderr.on('data',function(buf) {
  errdata += buf.toString()
})


child.stdout.on('data',function(buf) {
  data += buf.toString()
})

child.on("close",function(code) {
  console.log("CODE: "+code)
  if ( errdata ) {
    console.log(errdata)
    process.exit(1)
  }
  var parseString = require('xml2js').parseString;
  parseString(data, function (err, ledger) {
    if ( err ) { console.log("ERROR PARSING XML: "+err); process.exit(1) }
    ledger = ledger.ledger
    //console.log(JSON.stringify(ledger,null,'  '))
    
    var transactions = ledger.transactions[0].transaction
    console.log((transactions?transactions.length:0)+" transactions");
    var cnt = 0;
    _.each(transactions, function(xactxml) {

      if ( argv.verbose ) console.log("XACTXML:"+JSON.stringify(xactxml));
      var xact = new Xact(xactxml, argv.a);
      if ( argv.verbose ) console.log("XACT:"+JSON.stringify(xact));
      if ( argv.verbose ) console.log("XACTKEY:"+xact.bkey());

      var no = cnt++;
      var tot = xact.total()

      var year = xact.date.year()

      if ( argv.train ) {
        //var val = postings.length > 1 ? "SPLIT" : postings[0].account[0].name

        doTrain(argv.key, xact)

      } else {
        var bayes = getTransactionClassifier(argv.key, xact)

        category = bayes.classify(xact.tkey())
        console.log(xact.tkey()+" classified in: " + category);
      }
    });

    saveAllClassifiers()
  });
})
/*
bayes.train("cheap replica watches", 'spam', function() {
  console.log("trained");
});

bayes.classify("free watches", function(category) {
  console.log("classified in: " + category);
});
*/

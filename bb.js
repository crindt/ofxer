var spawn = require('child_process').spawn,
child;
var async = require('async')
var classifier = require('classifier')
var _ = require("lodash-node");
var argv = require("minimist")(
  process.argv.slice(2),
  { string: [ 'b', 'e', 'a' ] }
);
var moment = require('moment');
var amountMeta = require('./funcs.js').amountMeta;
var Xact = require('./funcs.js').Xact;
var stripXact = require('./funcs.js').stripXact;

var args = ["-f", argv.f, "xml", "reg", argv.a, "-r"];
if ( argv.b ) { args.push("-b");args.push(argv.b) }
if ( argv.e ) { args.push("-e");args.push(argv.e) }

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
    async.eachLimit(transactions, 30, function(xactxml, cb) {

      console.log("XACTXML:"+JSON.stringify(xactxml));
      var xact = new Xact(xactxml, argv.a);
      console.log("XACT:"+JSON.stringify(xact));

      var no = cnt++;
      var tot = xact.total()

      var year = xact.date.year()

      if ( argv.train ) {
        //var val = postings.length > 1 ? "SPLIT" : postings[0].account[0].name

        var tkey = xact.tkey(); // compute the key using actual values

        var xact_stripped = stripXact( xact );

        var val = JSON.stringify(xact_stripped);
        console.log("VAL: "+JSON.stringify(xact_stripped))

        // train for post year and following two years
        var years = [year,year+1,year+2];

        async.each(years,function(y, cb2) {
          var bayes = new classifier.Bayesian({
            backend: {
              type: 'Redis',
              options: {
                hostname: 'localhost', // default
                port: 6379,            // default
                name: [y,argv.a].join(":")           // namespace for persisting
              },
              thresholds: {
                "Expenses:Groceries:Food": 1,
                "Expenses:Groceries:Alcohol": 3
              }
            }
          });
          
          bayes.train(tkey,
                      val, function() {
                        console.log("trained ("+no+") for year "+y+": '"+tkey+"->"+val);
                        cb2()
                      })
        }, function(err) {
          if (err) { 
            console.log("ERROR TRAINING FOR YEAR",err)
            process.exit(1)
          }
          cb()
        })
      } else {
        var bayes = new classifier.Bayesian({
          backend: {
            type: 'Redis',
            options: {
              hostname: 'localhost', // default
              port: 6379,            // default
              name: [pdate.year,argv.a].join(":")           // namespace for persisting
            },
            thresholds: {
              "Expenses:Groceries:Food": 1,
              "Expenses:Groceries:Alcohol": 3
            }
          }
        });

        bayes.classify(key, function(category) {
          console.log(key+" classified in: " + category);
          cb()
        });        
      }

    }, function( err ) {

      if ( err ) { 
        console.log("Error processing");
        process.exit(1);
      }
    })
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

var spawn = require('child_process').spawn,
child;
var async = require('async')
var classifier = require('classifier')
var _ = require("lodash");
var argv = require("minimist")(
  process.argv.slice(2),
  { string: [ 'b', 'e', 'a' ] }
);
var moment = require('moment');
var amountMeta = require('./funcs.js').amountMeta;

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
    async.eachLimit(transactions, 30, function(xact, cb) {
      var payee = xact.payee[0];
      console.log(payee);
      var postings = xact.postings[0].posting;
      console.log("xact "+(cnt++)+": "+postings.length)
      var no = cnt;
      var tot = 0
      _.each(postings,function(p) {
        tot += parseFloat(p['post-amount'][0].amount[0].quantity[0])
      });

      var adds = []
      adds.push( amountMeta(tot) )

      var key = _.flatten([payee,adds]).join(" ")

      var pdate = moment(xact.date[0])
      console.log("date: "+pdate.year());      

      if ( argv.train ) {
        //var val = postings.length > 1 ? "SPLIT" : postings[0].account[0].name
        var val = ""
        val = [];
        _.each(postings, function( p ) {
          console.log(JSON.stringify(p));

          // only record nonzero splits
          var pamt = parseFloat(p['post-amount'][0].amount[0].quantity[0])/tot
          if ( pamt != 0 )
            val.push( { name: p.account[0].name[0], frac: pamt } );
        });
        val = JSON.stringify(val);

        // train for post year and following two years
        var years = [pdate.year(),pdate.year()+1,pdate.year()+2];

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
          
          bayes.train(key,
                      val, function() {
                        console.log("trained ("+no+") for year "+y+": '"+key+"->"+val);
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

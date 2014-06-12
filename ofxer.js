var spawn = require('child_process').spawn,
child;
var fs = require('fs');
var ofx = require('ofx');
var argv = require("minimist")(
  process.argv.slice(2),
  { string: [ 'f', 'l' ],
    boolean: [ 'train' ]
  }
);
var moment = require('moment');
var _ = require('lodash-node');
var async = require('async');
var classifier = require('classifier');
var prompt = require('prompt');
var sprintf = require('sprintf-js').sprintf;
var colors = require('colors');
var amountMeta = require('./funcs.js').amountMeta;

colors.setTheme({
  candidate: 'blue',
  trial: 'green'
});

// Closure
(function(){

	/**
	 * Decimal adjustment of a number.
	 *
	 * @param	{String}	type	The type of adjustment.
	 * @param	{Number}	value	The number.
	 * @param	{Integer}	exp		The exponent (the 10 logarithm of the adjustment base).
	 * @returns	{Number}			The adjusted value.
	 */
	function decimalAdjust(type, value, exp) {
		// If the exp is undefined or zero...
		if (typeof exp === 'undefined' || +exp === 0) {
			return Math[type](value);
		}
		value = +value;
		exp = +exp;
		// If the value is not a number or the exp is not an integer...
		if (isNaN(value) || !(typeof exp === 'number' && exp % 1 === 0)) {
			return NaN;
		}
		// Shift
		value = value.toString().split('e');
		value = Math[type](+(value[0] + 'e' + (value[1] ? (+value[1] - exp) : -exp)));
		// Shift back
		value = value.toString().split('e');
		return +(value[0] + 'e' + (value[1] ? (+value[1] + exp) : exp));
	}

	// Decimal round
	if (!Math.round10) {
		Math.round10 = function(value, exp) {
			return decimalAdjust('round', value, exp);
		};
	}
	// Decimal floor
	if (!Math.floor10) {
		Math.floor10 = function(value, exp) {
			return decimalAdjust('floor', value, exp);
		};
	}
	// Decimal ceil
	if (!Math.ceil10) {
		Math.ceil10 = function(value, exp) {
			return decimalAdjust('ceil', value, exp);
		};
	}

})();


var fitdb = {}


function processLedger(file, acct, cond, opts, cb) {

  var mycond = 'account=~/'+acct+'/'
  if ( cond ) mycond += "and ("+cond+")";

  var args = _.flatten([["-f", file, "xml", "--limit", mycond, "-r"], opts]);

  console.log(args)

  console.log("ledger ",_.map(args, function(a) { 
    console.log(a)
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
      cb(ledger)
    })
  })  
}

function ofx2ledger(acct, xact, split, notes, trial) {
  var line = [xact.DTPOSTED.replace(/^(\d\d\d\d)(\d\d)(\d\d).*$/,"$1/$2/$3"), xact.NAME].join(' ')
  if ( trial )
    console.log(line.trial.trial)
  else
    console.log(line.trial)
  if ( !trial ) console.log('    ; FITID:',xact.FITID)
  if ( notes && notes.length ) 
    console.log( '    ; '+notes.join("\n    ;"))
  var splits = [];
  _.each(split, function( s ) {
    var amt = -Math.round10(s.frac*xact.TRNAMT,-2)
    splits.push(sprintf("    %-60s    $%10.2f", s.name,amt))
  });
  if ( trial ) console.log(splits.join("\n").candidate);
  else console.log(splits.join("\n"));
  console.log(sprintf("    %-60s    $%10.2f",acct,parseFloat(xact.TRNAMT)));
}


function xactkey(xact) 
{
  var adds = []
  var tot = parseFloat(xact.TRNAMT)
  adds.push( amountMeta(tot) )
  var tkey = _.flatten([xact.NAME,adds]).join(" ")
  return tkey;
}

function doTrain(bkey,xact,category,cb) {
  // train for post year and following two years
  var pyear = parseInt(xact.DTPOSTED.substring(0,4))
  var years = [pyear,pyear+1,pyear+2];

  async.each(years,function(y, cb2) {
    var bayes2 = new classifier.Bayesian({
      backend: {
        type: 'Redis',
        options: {
          hostname: 'localhost', // default
          port: 6379,            // default
          name: bkey           // namespace for persisting
        },
        thresholds: {
          "Expenses:Groceries:Food": 1,
          "Expenses:Groceries:Alcohol": 3
        }
      }
    });
    
    var tkey = xactkey(xact)

    bayes2.train(tkey,
                 category, function() {
                   console.log("trained for "+bkey+": '"+tkey+"->"+category);
                   cb2()
                 })
  }, function(err) {
    if (err) { 
      console.log("ERROR TRAINING FOR YEAR",err)
      process.exit(1)
    }
    cb()
  })
}

function ledger2split(xact, expect) {
  var postings = xact.postings[0].posting;
  var tot = 0;
  _.each(postings,function(p) {
    tot += parseFloat(p['post-amount'][0].amount[0].quantity[0])
  });
  if ( tot != expect ) throw new Error("total "+tot+" != expect "+expect);
  var val = []
  _.each(postings, function( p ) {
    console.log(JSON.stringify(p));
    
    // only record nonzero splits
    var pamt = parseFloat(p['post-amount'][0].amount[0].quantity[0])/tot
    if ( pamt != 0 )
      val.push( { name: p.account[0].name[0], frac: pamt } );
  });
  return val;
}

function processOFX(cb) {

  var gacct = {
    "121000358:000913901777": { acct: "Assets:Current:BofA:Checking", type: "BANK" },
    "377254746491008": { acct: "Liabilities:Credit Cards:AMEX True Earnings", type: "CC" },
  }

  fs.readFile(argv.f, 'utf8', function(err, ofxData) {
    if (err) throw err;

    var data = ofx.parse(ofxData);

    var stmt, pfx
    if ( data.OFX.BANKMSGSRSV1 ) {
      stmt = data.OFX.BANKMSGSRSV1.STMTTRNRS.STMTRS
      pfx  = "BANK";
    } else if ( data.OFX.CREDITCARDMSGSRSV1 ) { 
      stmt = data.OFX.CREDITCARDMSGSRSV1.CCSTMTTRNRS.CCSTMTRS
      pfx  = "CC";
    } else {
      console.log("UNRECOGNIZED OFX TYPE")
      process.exit(1);
    }

   if ( stmt === undefined ) {
     console.log("NO DATA?");
     process.exit(1);
   }

    console.log(JSON.stringify(data,null,'  '));


    var acctkey;
    if ( pfx==="BANK" ) {
      acctkey = [stmt[pfx+"ACCTFROM"].BANKID,stmt[pfx+"ACCTFROM"].ACCTID].join(":");
    } else if ( pfx==="CC" ) {
      console.log(JSON.stringify(stmt,null,'  '))
      acctkey = [stmt[pfx+"ACCTFROM"].ACCTID].join(":");
    } else {
      console.log("UNRECOGNIZED ACCT ID");
      process.exit(1);
    }
    var acct = gacct[acctkey];
    if ( acct === undefined ) {
      console.log("Unknown Account: "+acctkey)
      process.exit(1);
    }

    processLedger(argv.l, acct.acct, "", [], function(ledger) {

      // update fitdb
      var transactions = ledger.transactions[0].transaction
      console.log((transactions?transactions.length:0)+" transactions");
      var cnt = 0;
      _.each(transactions, function(xact) {
        if ( xact.metadata ) {
          //console.log(JSON.stringify(xact,null,'  '));
          _.each(xact.metadata[0].value, function(v) {
            if ( v['$'].key.trim() === 'FITID' ) {
              fitdb[v.string.join("\n").trim()] = xact;
            }
          });
        }
      });
      console.log(JSON.stringify(fitdb,null,'  '))

      async.eachSeries(stmt["BANKTRANLIST"].STMTTRN.reverse(), function( xact, cb ) {
        var tkey = xactkey(xact)

        if ( fitdb[xact.FITID] ) {
          console.log(tkey,"already a transaction:",xact.FITID)

        } else {

          // see if matching transaction exists
          var amt = parseFloat(xact.TRNAMT)

          processLedger(argv.l, acct.acct, "(amount>"+(amt-0.01)+") and (amount<"+(amt+0.01)+")", [], function(l2) {

            var lxacts = l2.transactions[0].transaction;
            _.each(lxacts,function(lxact) {
              var split = ledger2split(lxact,-amt);
              console.log("CANDIDATE!".red)
              ofx2ledger(acct.acct, xact, split, [], true);
            });

            var bkey = [xact.DTPOSTED.substring(0,4), acct.acct].join(":")
            var bayes = new classifier.Bayesian({
              backend: {
                type: 'Redis',
                options: {
                  hostname: 'localhost', // default
                  port: 6379,            // default
                  name: bkey      // namespace for persisting
                },
                thresholds: {
                  "Expenses:Groceries:Food": 1,
                  "Expenses:Groceries:Alcohol": 3
                }
              }
            });


            bayes.classify(tkey, function(category) {
              console.log(category);
              var split = [{name:'unclassified', frac:1}];
              if (category!=='unclassified') split = JSON.parse(category)
              ofx2ledger(acct.acct, xact, split, [], true)

              var schema = {
                properties: {
                  yn: {
                    pattern: /^(y(es)?|no?)$/i,
                    message: 'Yes or No?',
                  default: "y",
                    required: true
                  }
                }
              };
              
              prompt.start()

              prompt.get(schema, function (err, result) {
                console.log("GOT ",result.yn)
                if ( !result.yn.match(/^y/i) ) { 
                  prompt.get({properties: {
                    "dosplits": {
                      description: "Specify splits?",
                      pattern: /^(y(es)?|no?)$/i,
                      message: 'Yes or No?',
                    }}}, function( err, res2 ) {
                      if ( res2.dosplits.match(/^y/i) ) {
                        var newsplit = []
                        var left = parseFloat(xact.TRNAMT)
                        async.whilst(
                          function() { return left != 0 },
                          function(cbg) {
                            prompt.get({properties: {
                              "account": {
                                description: "Account? ",
                              },
                              "amount": {
                                description: "Amount?",
                                pattern: /^-?(\d?\d?\d(,\d\d\d)*|\d+)(\.\d\d)?$/,
                                'default': (sprintf("%0.2f",-left))
                              }
                            }}, function(err, res3) {
                              if ( err ) cbg(err);
                              var amt = parseFloat(res3.amount)
                              newsplit.push({name:res3.account,
                                             frac:-amt/parseFloat(xact.TRNAMT)})
                              left += parseFloat(amt)
                              cbg();
                            });
                          },
                          function whilstError(err) {
                            if ( err ) cb(err)
                            
                            // FIXME: train it here
                            var notes = ['CXER: '+xact.FITID];
                            ofx2ledger(acct.acct, xact, newsplit, notes)

                            if ( argv.train ) 
                              doTrain(bkey,xact,JSON.stringify(newsplit),cb)
                            else cb()

                          });
                      } else {
                        split = [{name:'unclassified', frac:1}];
                        ofx2ledger(acct.acct, xact, split, notes)
                        cb()
                      }
                      
                    })

                } else {

                  // FIXME: train it here
                  var notes = ['CXER: '+xact.FITID];
                  ofx2ledger(acct.acct, xact, split, notes)

                  if ( argv.train ) 
                    doTrain(bkey,xact,category,cb);
                  else {
                    cb()
                  }
                }
              });
            });
          });
        }

      }, function( err ) {
        if ( err ) 
          console.log(err);
        else
          console.log("Done!");
      });
    });
  });
}

processOFX(function() {});

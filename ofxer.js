var spawn = require('child_process').spawn,
child;
var fs = require('fs');
var ofx = require('ofx');
var argv = require("minimist")(
  process.argv.slice(2),
  { string: [ 'f', 'l', 'key' ],
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
var Xact = require('./funcs.js').Xact;
var dp2date = require('./funcs.js').dp2date;
var stripXact = require('./funcs.js').stripXact;
var doTrain = require('./funcs.js').doTrain;
var getClassifier = require('./funcs.js').getClassifier;
var exDist = require('./funcs.js').exDist;
var dtf = "YYYY-MM-DD"

if ( ! argv.key ) {
  throw new Error("GOTTA SPECIFY THE FILE KEY")
}

colors.setTheme({
  info: 'blue',
  candidate: 'yellow',
  trial: 'yellow',
  selected: 'green'
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

  if ( argv.verbose ) console.log("ledger ",_.map(args, function(a) { 
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
    if ( argv.verbose ) console.log("CODE: "+code)
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

function ofx2ledger(dt, name, notes, acct, tamt, split, trial) {
  var line = [dt, name].join(' ')
  if ( trial )
    console.log(line.trial.trial)
  else
    console.log(line.trial)
  if ( notes && notes.length ) 
    console.log( '    ; '+notes.join("\n    ;"))
  var splits = [];
  _.each(split, function( s ) {
    var amt = -Math.round10(s.frac*tamt,-2)
    splits.push(sprintf("    %-60s    $%10.2f", s.name,amt))
  });
  if ( trial ) console.log(splits.join("\n").candidate);
  else console.log(splits.join("\n"));
  console.log(sprintf("    %-60s    $%10.2f", acct, tamt));
}

function xact2ledger(xact, status, indent) {
  function emit(str) {
    if ( status )
      console.log(indent+str[status])
    else
      console.log(indent+str)
  }
  function emitif(val) { if ( val !== undefined ) emit(val) }
  var line = [moment(xact.date).format('YYYY-MM-DD'), xact.payee].join(' ')
  emitif(line)
  emitif(xact.memo)
  if ( xact.metadata ) _.each(xact.metadata, function(v,k) { emit('    ; '+[k,v].join(': ')); });
                                                                  
  var tamt = 0;
  _.each(xact.postings, function( p ) {
    //var amt = -Math.round10(s.frac*tamt,-2)
    emit(sprintf("    %-60s    $%10.2f", p.account.name, -p.amt.val))
    tamt += p.amt.val;
  });
}

function ledger2split(acct, xact, expect) {
  var postings = xact.postings[0].posting;
  var tot = 0;
  _.each(postings,function(p) {
    tot += parseFloat(p['post-amount'][0].amount[0].quantity[0])
  });
  var val = []
  _.each(postings, function( p ) {
    
    // only record nonzero splits
    var pamt = parseFloat(p['post-amount'][0].amount[0].quantity[0])/tot
    if ( pamt != 0 ) {
      val.push( { name: p.account[0].name[0], frac: pamt } );
    }
  });
  if ( tot != expect ) {
    ofx2ledger(dp2date(xact.DTPOSTED), xact.NAME, [xact.MEMO, "FITID: "+xact.fitid()], val, true)
    throw new Error("total "+tot+" != expect "+expect);
  }
  return val;
}


var gacct = {
  "121000358:000913901777": { acct: "Assets:Current:BofA:Checking", type: "BANK" },
  "377254746491008": { acct: "Liabilities:Credit Cards:AMEX True Earnings", type: "CC" },
}


function processOFX(cb) {

  fs.readFile(argv.f, 'utf8', function(err, ofxData) {
    if ( err ) cb(err)

    var data = ofx.parse(ofxData);

    if ( argv.verbose ) console.log(data);

    cb(null, data)
  })
}

function ofx2stmt(ofx) {
  var stmt, pfx
  if ( ofx.OFX.BANKMSGSRSV1 ) {
    stmt = ofx.OFX.BANKMSGSRSV1.STMTTRNRS.STMTRS
    pfx  = "BANK";
  } else if ( ofx.OFX.CREDITCARDMSGSRSV1 ) { 
    stmt = ofx.OFX.CREDITCARDMSGSRSV1.CCSTMTTRNRS.CCSTMTRS
    pfx  = "CC";
  } else {
    console.log("UNRECOGNIZED OFX TYPE")
    process.exit(1);
  }
  
  if ( stmt === undefined ) {
    throw new Error("NO STMT DATA?");
  }
  return {stmt:stmt,pfx:pfx}
}

function readSplits(xacta,cb) {
  var xact = _.cloneDeep(xacta)

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
          description: "Amount ["+(left)+"]?",
          pattern: /^-?(\d?\d?\d(,\d\d\d)*|\d+)(\.\d\d)?$/,
          'default': (sprintf("%0.2f",-left))
        }
      }}, function(err, res3) {
        if ( err ) cbg(err);
        console.log("AMOUNT READ: "+res3.amount)
        var amt = parseFloat(res3.amount)
        newsplit.push({account: { name:res3.account }},
                      {amt: { cmdty: '$', val: -amt }})
        left += parseFloat(amt)
        cbg();
      });
    },
    function whilstError(err) {
      xact.postings = newsplit;
      xact.metadata.source = "manual"

      cb(err, xact)
    });

}

function getAccount(ofx, cb) {
  var acctkey;
  var stmt = ofx2stmt(ofx).stmt
  var pfx  = ofx2stmt(ofx).pfx

  if ( pfx==="BANK" ) {
    acctkey = [stmt[pfx+"ACCTFROM"].BANKID,stmt[pfx+"ACCTFROM"].ACCTID].join(":");
  } else if ( pfx==="CC" ) {
    acctkey = [stmt[pfx+"ACCTFROM"].ACCTID].join(":");
  } else {
    cb(new Error("UNRECOGNIZED ACCT ID"))
  }
  var acct = gacct[acctkey];
  return acct
}

// Here's the main logic
async.waterfall([
  processOFX,

  function getAccountWrapper(ofx, cb) {
    acct = getAccount(ofx);
    var err;
    if (acct == undefined) cb( "Unknown Account: "+acct )
    else 
      console.log( "GOT ACCOUNT "+JSON.stringify(acct).info )
    cb(null, ofx, acct)
  },

  function updateFitDb(ofx, acct, cb) {
    processLedger(argv.l, acct.acct, "", [], function( ledger ) {

      // update fitdb
      var transactions = ledger.transactions[0].transaction
      console.log((transactions?transactions.length:0)+" transactions in ledger");
      var cnt = 0;
      _.each(transactions, function(ledgerxact) {
        var xact = new Xact(ledgerxact, acct.acct)
        if ( xact.fitid() ) {
          fitdb[xact.fitid()] = xact;
        }
      });

      if ( argv.verbose ) console.log("UPDATED FITDB".info)
      cb(null,ofx, acct)
    })
  },

  function findLedgerMatches(ofx, acct) {
    var stmt = ofx2stmt(ofx).stmt
    var pfx  = ofx2stmt(ofx).pfx

    var adds = []

    async.eachSeries(stmt["BANKTRANLIST"].STMTTRN.reverse(), function( ofxxact, cb ) {
      var xact_ofx = new Xact(ofxxact, acct.acct)
      xact_ofx.postings[0].account = {name: 'unspecified'}
      xact_ofx.metadata.source = 'rawofx'
      console.log("\n===============================================\nOFX TRANSACTION...".red)
      xact2ledger(xact_ofx, 'trial', '   ')
      console.log("===============================================".red)


      var tkey = xact_ofx.tkey()

      if ( fitdb[xact_ofx.fitid()] ) {
        console.log([tkey,"already a transaction:",xact_ofx.fitid()].join(" ").info)

      } else {

        if ( argv.verbose ) console.log("FINDING MATCHES".info)

        async.waterfall([
          function matchExisting(cb2) {
            if ( argv.verbose ) console.log("...EXISTING?".info)

            // see if matching transaction exists within one week on either side
            var amt = parseFloat(xact_ofx.amount())
            var b = xact_ofx.date.clone()
            b.subtract('days',7)
            var e = xact_ofx.date.clone()
            e.add('days',7)
            var window = Math.abs(amt)*0.25  // 5%
            processLedger(argv.l, acct.acct, "(amount>"+((-amt)-window)+") and (amount<"+((-amt)+window)+")", ['-b', b.format(dtf), '-e', e.format(dtf)], function(l2) {

              var existingsplits = []
              var lxacts = l2.transactions[0].transaction;
              if (argv.verbose) console.log("LXACTS:"+JSON.stringify(lxacts))
              _.each(lxacts,function(lxact) {  // loop over matching ledger xacts
                var xact_led = new Xact(lxact, acct.acct)
                existingsplits.push(xact_led)
              });
              existingsplits = existingsplits.sort(function(a,b) {
                return exDist(a,xact_ofx) - exDist(b,xact_ofx)
              })
              cb2(null, existingsplits);
            })
          },

          function bayesianMatch(exsplits, cb2) {
            if ( argv.verbose ) console.log("...BAYESIAN?".info)

            var bayes = getClassifier(argv.key, xact_ofx)

            bayes.classify(tkey, function(category) {
              if ( category === 'unclassified' ) {
                cb2(null, exsplits, null)

              } else {
                var xact_bayes = _.merge(new Xact(),xact_ofx);
                var guess = _.pick(JSON.parse(category), function(v,k) { return k.match(/^(postings)/)})
                _.merge(xact_bayes, guess)
                xact_bayes.date = moment(xact_bayes.date)
                // expand fractions to amounts from the OFX
                var tot = xact_ofx.total()
                _.each(xact_bayes.postings, function(p) {
                  p.amt.val = p.amt.val * tot
                });
                
                xact_bayes.metadata.source = 'bayes'
                cb2(null, exsplits, xact_bayes)
              }
            })
          },

          function showOptions(exsplits, xact_bayes, cb2) {

            var cnt = 0;
            var choices = ["x","s"]
            var defaults = []

            _.each(exsplits, function(xact) {
              defaults.push(cnt)
              console.log(('   '+"\n"+cnt+") EXISTING TRANSACTION ["+exDist(xact,xact_ofx)+"]").info)
              xact2ledger(xact, 'trial', '   ')
              cnt++
            });
            if ( exsplits.length > 0 ) {
              choices.push('\\d+')
            }

            if ( xact_bayes ) {
              console.log('   '+"\nb) BEST BAYESIAN GUESS:".info)
              //ofx2ledger(dp2date(xact.DTPOSTED), xact.NAME, [xact.MEMO, "FITID: "+xact.fitid], parseFloat(xact.TRNAMT), true)
              xact2ledger(xact_bayes, 'trial', '   ')
              choices.push("b")
              defaults.push("b")
            }
            
            console.log('   '+"\ns) MANUALLY SPECIFY SPLITS".info)
            defaults.push("s")
            
            console.log('   '+"\nx) USE RAW OFX".info)
            defaults.push("x")

            patt = new RegExp("("+choices.join("|")+")","i")
            var dflt = defaults[0]

            prompt.start()
            prompt.get({
              properties: {
                'split': {
                  description: "Choose which split to apply",
                  pattern: patt,
                  message: 'Choose a <number> or x',
                  'default': dflt,
                  required: true
                }
              }
            }, function (err, result) {
              console.log("GOT ",result.split)
              cb2(err, exsplits, xact_bayes, result)
            })
          },

          function chooseMatch(exsplits, xact_bayes, result, cb2) {
            if ( result.split === 'x' ) {
              // cancel, unspecified
              
              console.log(JSON.stringify(xact_ofx))
              cb2(null, xact_ofx)

            } else if ( result.split === 's' ) {
              console.log("Specify Splits...")
              // FIXME
              readSplits(xact_ofx, function(err, xact_new) {
                adds.push(xact_new)
                cb2(err, xact_new)
              });

            } else if ( result.split === 'b' ) {

              adds.push(xact_bayes)
              cb2(null, xact_bayes)

            } else {
              var splitno = parseInt(result.split)
              if ( (splitno) < exsplits.length ) {
                // chose existing split

                var xact_existing   = exsplits[splitno]
                xact_existing.metadata.fitid = xact_ofx.fitid()

                cb2(null, xact_existing)
                
              } else {
                cb2("SHOULDN'T GET HERE!")
              }
            }
          },

          function emitMatch(xact_chosen, cb2) {

            // apply FITID
            xact2ledger(xact_chosen, 'selected', '   ')

            cb2(null, xact_chosen)

          },

          function trainMatch(xact_chosen, cb2) {

            if ( argv.train && !(xact_chosen.metadata.source=="rawofx") ) {
              
              doTrain(argv.key, xact_chosen, function(err) {
                cb2(err, xact_chosen)
              });
            } else {
              cb2(null, xact_chosen)
            }
          }

        ], function matchError(err, result) {
          if ( err ) cb(err);

          // WRITE OUT ALL ADDS
          _.each(adds,function(xact_add) {
            xact2ledger(xact_add)
          })

          cb(null, result);
        })
      }
    })
  }
], function(err, result) {
  if ( err ) throw err
  console.log(JSON.stringify(result));
})

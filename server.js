require('dotenv').config();

var _ = require('underscore');
var moment = require('moment');
var Redshift = require('node-redshift');

var express = require('express');
var bodyParser = require('body-parser');
var app = express();

app.use(express.static('public'));
app.use(bodyParser.json({limit: '50mb'}));

var jsforce = require('jsforce');
var conn = new jsforce.Connection();
var sfdc_login = process.env.SFDC_LOGIN;
var sfdc_password = process.env.SFDC_PASSWORD;
var sfdc_token = process.env.SFDC_TOKEN;

var TOTANGO_KEY = process.env.TOTANGO_KEY,
    async = require('async'),
    crypto = require('crypto'),
    request = require('request');

var client = {
  user: process.env.REDSHIFT_USER,
  database: process.env.REDSHIFT_DB,
  password: process.env.REDSHIFT_PASSWORD,
  port: process.env.REDSHIFT_PORT,
  host: process.env.REDSHIFT_HOST,
};

// Simply forward this to the API server
var basicAuth = require('basic-auth');
var BASIC_AUTH = {
  name: process.env.USERNAME,
  pass: process.env.PASSWORD
};

function auth(req, res, next) {
  function unauthorized(res) {
    res.set('WWW-Authenticate', 'Basic realm=Autorization Required');
    return res.sendStatus(401);
  }

  var user = basicAuth(req);
  if(!user || !user.name || !user.pass)
    return unauthorized(res);

  if (user.name === BASIC_AUTH.name && user.pass == BASIC_AUTH.pass)
    return next();

  return unauthorized(res);
}

function setDiscountHistory(events) {
  var DiscountStates = function () {
    this.states = [];
  };

  DiscountStates.prototype.getStateAt = function(at) {
    var closestState = null;
    this.states.forEach(function (state) {
      if (state.ts <= at)
        closestState = state;
    });
    return closestState;
  };

  var discountStates = new DiscountStates();

  events.forEach(function (event) {
    if (event.event_type.indexOf('discount') !== -1) {
      var discountState = {
        ts: event.event_created,
        amount_off: event.coupon_amount_off,
        percent_off: event.coupon_percent_off,
        start: event.start,
        end: event.end,
        duration: event.coupon_duration,
        valid: event.coupon_valid
      };

      if (event.event_type.indexOf('deleted') !== -1) {
        discountState.amount_off = 0;
        discountState.percent_off = 0;
      }

      discountStates.states.push(discountState);
    }
  });

  return discountStates;
}

var Customer = function (id, events) {
  this.id = id;
  this.events = _.sortBy(events, 'event_created');
  this.discountHistory = setDiscountHistory(this.events);
  this.first_event = null;

  // get first state
  for (var i = 0; i < this.events.length; i++) {
    if (this.events[i].event_type.indexOf('subscription.created') !== -1) {
      this.first_event = this.events[i];
      break;
    }
  }
};

Customer.prototype.getDiscountAt = function(at) {
  return this.discountHistory.getStateAt(at);
};

Customer.prototype.getMrrAt = function(at) {
  function applyDiscount(mrr, discount) {
    if (!discount)
      return mrr;

    if (discount.end && discount.end <= at)
      return mrr;

    if (!discount.valid && !discount.end && discount.duration !== 'forever')
      return mrr;

    mrr -= discount.amount_off;
    mrr *= (100 - discount.percent_off) / 100;

    return mrr;
  }

  var lastEvent = null;
  var lastSubscriptionEvent = null;
  for (var i = 0; i < this.events.length; i++) {
    if (this.events[i].event_type.indexOf('subscription') !== -1 && this.events[i].event_created <= at)
      lastSubscriptionEvent = this.events[i];
  }

  if (!lastSubscriptionEvent)
    return 0;

  if (lastSubscriptionEvent.event_type.indexOf('deleted') !== -1)
    return 0;

  if (lastSubscriptionEvent.status === 'unpaid')
    return 0;

  var rr = lastSubscriptionEvent.plan_amount * lastSubscriptionEvent.quantity;
  rr = applyDiscount(rr, this.getDiscountAt(at));
  var mrr = (lastSubscriptionEvent.plan_id.indexOf('year') !== -1) ? rr / 12 : rr;

  return Math.round(mrr);
};

Customer.prototype.getNewBizBy = function(by) {
  var endOfPeriod = Math.min(by, moment.unix(this.first_event.event_created).utc().add(30, 'days').endOf('day').unix());
  return this.getMrrAt(endOfPeriod);
}

Customer.prototype.getMovementBetween = function(fr, to) {
  // No creation event: I give up
  if (!this.first_event)
    return {newBiz: 0, movement: 0, churn: 0};

  var newBizWas = this.getNewBizBy(fr);
  var newBizIs = this.getNewBizBy(to);
  var netNewBiz = newBizIs - newBizWas;

  var MrrWas = this.getMrrAt(fr);
  var MrrIs = this.getMrrAt(to);
  var netMovement = MrrIs > 0 ? MrrIs - MrrWas - netNewBiz : 0;
  var churn = MrrIs === 0 ? -1 * (MrrWas+netNewBiz) : 0;

  return {newBiz: netNewBiz, movement: netMovement, churn: churn};
}

var stripe_to_id = {},
    customers = [],
    owners = {},
    assists = [];

var arrGoals = {
  q1: 73969100,
  q2: 134675600,
  q3: 134608500,
  q4: 223337100
};

var updateData = function() {  
  console.log('Updating data', Date.now());

  // Get closed won that were sales assisted
  getSalesAssistedAccounts(function (err, results) {
    assists = results;

    // Get Customer Success account owners
    getCustomerSuccessSplit(function (err, accounts) {
      owners = {};
      accounts.forEach(function(acc) {
        var owner = acc.selected_fields[0],
            id = parseInt(acc.name);
        owners[id] = (owner === 'Cori Morris') ? 'self-served' : owner;
      });


      // Get map from stripe_id to company_id
      var query = 'SELECT id, stripe_id FROM front.companies WHERE stripe_id is not null;';

      var redshiftClient = new Redshift(client);
      redshiftClient.query(query, function (err, table) {

        if(err) return console.error('could not query db', err);

        stripe_to_id = {};
        table.rows.forEach(function (company) {
          stripe_to_id[company.stripe_id] = company.id;
        });


        // Get all subscription events
        var query = 'SELECT * FROM stripe.events;';

        var redshiftClient = new Redshift(client);
        redshiftClient.query(query, function (err, events) {

          if(err) return console.error('could not query db', err);

          // Get all discount events
          var query = 'SELECT * FROM stripe.customer_discounts;';

          var redshiftClient = new Redshift(client);
          redshiftClient.query(query, function (err, discounts) {

            if(err) return console.error('could not query db', err);

            var event_history = {};

            events.rows.forEach(function (event) {
              if (typeof event_history[event.customer] === 'undefined')
                event_history[event.customer] = [event];
              else
                event_history[event.customer].push(event);
            });

            discounts.rows.forEach(function (discount) {
              if (typeof event_history[discount.customer] === 'undefined')
                event_history[discount.customer] = [discount];
              else
                event_history[discount.customer].push(discount);
            });

            customers = [];

            _.each(event_history, function (customer_events, customer) {
              customers.push(new Customer(customer, customer_events));
            });

            console.log('Updated', Date.now());
          });
        });
      });
    });
  });
};

var getSalesAssistedAccounts = function (done) {
  conn.login(sfdc_login, sfdc_password+sfdc_token, function (err, res) {
    if (err) { return console.error(err); }

    conn.query('SELECT Id, Stripe_Id__c FROM Opportunity WHERE AE_touch__c = true AND Stripe_Id__c != null', function (err, res) {
      if (err) { return done(err); }

      var assists =  res.records.map(function (record) { return record.Stripe_Id__c; });
      return done(null, assists);
    });
  });
};

var getCustomerSuccessSplit = function (done, data, offset) {
  if (typeof data === 'undefined')
    data = [];

  if (typeof offset === 'undefined')
    offset = 0;

  var dataString = 'query={"terms":[{"type":"owner","is_one_of":["andersen@frontapp.com","samantha@frontapp.com","team@frontapp.com"]}],"count":1000,"offset":'+offset+',"fields":[{"type":"string_attribute","attribute":"Success Manager","field_display_name":"Success Manager"}],"scope":"all"}';

  var options = {
      url: 'https://app.totango.com/api/v1/search/accounts',
      method: 'POST',
      form: dataString,
      headers: {'app-token': process.env.TOTANGO_KEY}
  };

  function callback(error, response, body) {
      var res = JSON.parse(body);
      if (!error && response.statusCode == 200) {
        var hits = data.concat(res.response.accounts.hits);

        // paginate
        if (hits.length < res.response.accounts.total_hits)
          return getCustomerSuccessSplit(done, hits, offset + 1000)

        return done(null, hits);
      } else {
        return done(error, res);
      }
  }

  request(options, callback);
}

var ignoredCustomers = ['cus_9WHyFCy2n51cmi', 'cus_96StY6QIjBbe5I'];
updateData();
setInterval(updateData, 1000 * 60 * 10);

app.get('/mrr', auth, function (req, res) {
  var fr = moment.utc(req.query.from).unix(),
    to = moment.utc(req.query.to).add(1, 'days').unix();

  var mrrWas = _.reduce(customers, function (memo, customer) { return memo + customer.getMrrAt(fr); }, 0);
  var mrrIs = _.reduce(customers, function (memo, customer) { return memo + customer.getMrrAt(to); }, 0);

  console.log(mrrIs - mrrWas, mrrIs / mrrWas);

  var newBiz = {count: 0, value: 0, assisted: {}};
  var upsell = {count: 0, value: 0, managers: {}};
  var downsell = {count: 0, value: 0, managers: {}};
  var churn = {count: 0, value: 0, managers: {}};

  customers.forEach(function (customer) {
    if (ignoredCustomers.indexOf(customer.id) !== -1)
      return;

    var mrr = customer.getMovementBetween(fr, to);

    if (mrr.newBiz !== 0) {
      newBiz.count++;
      newBiz.value += mrr.newBiz;
      
      var assist = assists.indexOf(customer.id) !== -1 ? 'Sales assisted' : 'self-served';
      if (typeof newBiz.assisted[assist] === 'undefined') {
        newBiz.assisted[assist] = {count: 1, value: mrr.newBiz};
      } else {
        newBiz.assisted[assist].count++;
        newBiz.assisted[assist].value += mrr.newBiz;
      }
    }

    if (mrr.movement > 0) {
      upsell.count++;
      upsell.value += mrr.movement;

      var manager = owners[stripe_to_id[customer.id]] || 'N/A';
      if (typeof upsell.managers[manager] === 'undefined')
        upsell.managers[manager] = {count: 1, value: mrr.movement}
      else {
        upsell.managers[manager].count++;
        upsell.managers[manager].value += mrr.movement;
      }
    }

    if (mrr.movement < 0) {
      downsell.count++;
      downsell.value += mrr.movement;

      var manager = owners[stripe_to_id[customer.id]] || 'N/A';
      if (typeof downsell.managers[manager] === 'undefined')
        downsell.managers[manager] = {count: 1, value: mrr.movement}
      else {
        downsell.managers[manager].count++;
        downsell.managers[manager].value += mrr.movement;
      }
    }

    if (mrr.churn < 0) {
      churn.count++;
      churn.value += mrr.churn;

      var manager = owners[stripe_to_id[customer.id]] || 'N/A';
      if (typeof churn.managers[manager] === 'undefined')
        churn.managers[manager] = {count: 1, value: mrr.churn}
      else {
        churn.managers[manager].count++;
        churn.managers[manager].value += mrr.churn;
      }
    }
  });

  // FIXME: remove once change to SSY billing PSA (26007) has propagated
  if (to > moment().unix() && upsell.managers['Samantha Wong']) {
    var temp_ssy_deal = 250000;
    upsell.value += temp_ssy_deal;
    upsell.managers['Samantha Wong'].value += temp_ssy_deal;
  }

  res.send({
    new_biz: newBiz, 
    churn: churn, 
    upsell: upsell, 
    downsell: downsell
  });
});

app.get('/customers', auth, function (req, res) {
  var now = moment.utc().endOf('day').unix();
  var count = _.countBy(customers, function (customer) { return customer.getMrrAt(now) > 0 ? 'present' : 'past'; });

  res.send({count: count.present});
});

app.get('/quota', auth, function (req, res) {
  var fr = moment.utc().startOf('quarter').unix(),
    to = moment.utc().endOf('day').unix();

  var mrrWas = _.reduce(customers, function (memo, customer) { return memo + customer.getMrrAt(fr); }, 0);
  var mrrIs = _.reduce(customers, function (memo, customer) { return memo + customer.getMrrAt(to); }, 0);
  // FIXME: remove after Q1
  var temp_shopify_deal = 208333;
  var temp_ssy_deal = 250000;
  var addedMrr = mrrIs - mrrWas + temp_shopify_deal + temp_ssy_deal;

  var currentQuarter = 'q' + moment().utc().quarter();
  var quota = Math.round(1000 * 12 * addedMrr / arrGoals[currentQuarter]) / 1000;
  res.send({quota: quota});
});

app.get('/to-go', auth, function (req, res) {
  var fr = moment.utc().startOf('quarter').unix(),
    to = moment.utc().endOf('day').unix();

  var mrrWas = _.reduce(customers, function (memo, customer) { return memo + customer.getMrrAt(fr); }, 0);
  var mrrIs = _.reduce(customers, function (memo, customer) { return memo + customer.getMrrAt(to); }, 0);
  // FIXME: remove after Q1
  var temp_shopify_deal = 208333;
  var temp_ssy_deal = 250000;
  var addedMrr = mrrIs - mrrWas + temp_shopify_deal + temp_ssy_deal;

  var currentQuarter = 'q' + moment().utc().quarter();
  var to_go = Math.round(( arrGoals[currentQuarter] - (12 * addedMrr) ) / 1200);
  res.send({to_go: to_go});
});

app.get('/expansion', auth, function (req, res) {
  var fr = moment.utc().subtract(30, 'days').subtract(1, 'years').unix(),
    to = moment.utc().subtract(30, 'days').endOf('day').unix();

  var newBiz = _.reduce(customers, function (memo, customer) { return memo + customer.getMovementBetween(fr, to).newBiz; }, 0);
  var upsell = _.reduce(customers, function (memo, customer) { var move = customer.getMovementBetween(fr, to); return memo + move.movement + move.churn; }, 0);

  res.send({expansion: (upsell / newBiz) + 1});
});

var port = process.env.PORT || 2474;
app.listen(port, function () { console.log('App running on port', port); });
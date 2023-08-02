const express = require("express");
const path = require("path");
require("dotenv").config();
var bodyParser = require("body-parser");
const moesif = require("moesif-nodejs");
const Stripe = require("stripe");
var cors = require("cors");
const fetch = require("node-fetch");
const { Client } = require("@okta/okta-sdk-nodejs");
const { ManagementClient } = require('auth0');
const { registerStripeCheckout } = require('./register');

const app = express();
app.use(express.static(path.join(__dirname)));
const port = 3030;
const apimProvider = process.env.APIM_PROVIDER;

const moesifManagementToken = process.env.MOESIF_MANAGEMENT_TOKEN;
const templateWorkspaceIdLiveEvent =
  process.env.MOESIF_TEMPLATE_WORKSPACE_ID_LIVE_EVENT_LOG;
const templateWorkspaceIdTimeSeries =
  process.env.MOESIF_TEMPLATE_WORKSPACE_ID_TIME_SERIES;
const moesifApiEndPoint = "https://api.moesif.com";

const stripe = Stripe(process.env.STRIPE_KEY);
var jsonParser = bodyParser.json();

const moesifMiddleware = moesif({
  applicationId: process.env.MOESIF_APPLICATION_ID,

  identifyUser: function (req, _res) {
    return req.user ? req.user.id : undefined;
  },

  identifyCompany: function (req, res) {
    // your code here, must return a string
    return req.headers["X-Organization-Id"];
  },
});

app.use(moesifMiddleware, cors());

app.post("/okta/register", jsonParser, async (req, res) => {
  try {
    const oktaClient = new Client({
      orgUrl: process.env.OKTA_DOMAIN,
      token: process.env.OKTA_API_TOKEN,
    });

    const { firstName, lastName, email, password } = req.body;

    const newUser = {
      profile: {
        firstName,
        lastName,
        email,
        login: email,
      },
      credentials: {
        password: {
          value: password,
        },
      },
    };

    const response = await fetch(`${process.env.OKTA_DOMAIN}/api/v1/users`, {
      method: "POST",
      headers: {
        Authorization: `SSWS ${process.env.OKTA_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(newUser),
    });

    if (!response.ok) {
      throw new Error("Failed to create user");
    }

    const createdUser = await response.json();

    res
      .status(201)
      .json({ message: "User created successfully", user: createdUser });

    try {
      console.log(
        `URL = ${process.env.OKTA_DOMAIN}/api/v1/apps/${process.env.OKTA_APPLICATION_ID}/users/${createdUser.id}`
      );
      const assignUserResponse = await fetch(
        `${process.env.OKTA_DOMAIN}/api/v1/apps/${process.env.OKTA_APPLICATION_ID}/users/${createdUser.id}`,
        {
          method: "PUT",
          headers: {
            Authorization: `SSWS ${process.env.OKTA_API_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!assignUserResponse.ok) {
        throw new Error("Failed to assign user to application");
      }
      console.log("User assigned to application successfully.");
    } catch (error) {
      console.error("Failed to assign user to application:", error.message);
    }
  } catch (error) {
    console.error("Error creating user:", error);
    res.status(500).json({ message: "Failed to create user" });
  }
});

app.post("/register", jsonParser, async (req, res) => {
  try {
    const email = req.body.email;
    const stripe_customer_id = req.body.customer_id;
    const stripe_subscription_id = req.body.subscription_id;

    var company = { companyId: stripe_subscription_id };
    moesifMiddleware.updateCompany(company);

    var user = {
      userId: stripe_customer_id,
      companyId: stripe_subscription_id,
      metadata: {
        email: email,
      },
    };
    moesifMiddleware.updateUser(user);

    if(apimProvider === "Kong") {

      var body = { username: req.body.email, custom_id: stripe_customer_id };
      await fetch(`${process.env.KONG_URL}/consumers/`, {
        method: "post",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
    } else if(apimProvider === "AWS") {
      const auth0 = new ManagementClient({
        token: process.env.AUTH0_MANAGEMENT_API_TOKEN,
        domain: process.env.AUTH0_DOMAIN,
      });

      // Find the user in Auth0 by their email
      const users = await auth0.getUsersByEmail(email);
      const user = users[0];

      // Update the user's app_metadata with the stripe customer ID
      await auth0.updateUser({
        id: user.user_id}, {
        app_metadata: {
          stripeCustomerId: stripe_customer_id,
          stripeSubscriptionId: stripe_subscription_id
        }
      });
    }
    res.status(200);
  } catch (error) {
    console.error("Error registering user:", error);
    res.status(500).json({ message: "Failed to register user" });
  }
});

app.post("/create-key", jsonParser, async function (req, res) {
  try {
    const email = req.body.email;
    var apiKey = "";

    if (apimProvider === "Kong") {
      const response = await fetch(
        `${process.env.KONG_URL}/consumers/${encodeURIComponent(email)}/key-auth`,
        {
          method: "post",
        }
      );
      var data = await response.json();
      apiKey = data.key;
      res.status(200);
      res.send({ apikey: apiKey });
    } else if (apimProvider === "AWS") {

      var auth0Jwt = req.headers.authorization; // Get the Auth0 JWT from the request

      if (!auth0Jwt) {
          throw new Error('No authorization header provided');
      }

      if (!auth0Jwt.startsWith('Bearer ')) {
          throw new Error('Invalid authorization header');
      }

      auth0Jwt = auth0Jwt.slice(7);
      res.status(200).send({ apikey: auth0Jwt });

    }
  } catch (error) {
    console.error("Error creating key:", error);
    res.status(500).json({ message: "Failed to create key" });
  }
});


if (!moesifManagementToken) {
  console.error(
    "No MOESIF_MANAGEMENT_TOKEN found. Please create an .env file with MOESIF_MANAGEMENT_TOKEN & MOESIF_TEMPLATE_WORKSPACE_ID."
  );
}

if (!templateWorkspaceIdLiveEvent) {
  console.error(
    "No MOESIF_TEMPLATE_WORKSPACE_ID found. Please create an .env file with MOESIF_MANAGEMENT_TOKEN & MOESIF_TEMPLATE_WORKSPACE_ID."
  );
}

app.get("/embed-dash-time-series(/:userId)", function (req, res) {
  try {
    const userId = req.params.userId;
    const templateData = {
      template: {
        values: {
          user_id: userId,
        },
      },
    };

    // Set your desired expiration for the generated workspace token.
    // Moesif's recommendation is to match or be larger than your user's session time while keeping time period less than 30 days.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 7);
    const expiration = tomorrow.toISOString();

    const moesif_url_time_series = `${moesifApiEndPoint}/v1/portal/~/workspaces/${templateWorkspaceIdTimeSeries}/access_token?expiration=${expiration}`;

    fetch(moesif_url_time_series, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${moesifManagementToken}`,
      },
      body: JSON.stringify(templateData),
    })
      .then((response) => {
        if (response.ok) {
          return response;
        } else {
          console.log("Api call to moesif not successful. server response is:");
          console.error(response.statusText);
          throw Error(response.statusText);
        }
      })
      .then((response) => {
        return response.json();
      })
      .then((info) => {
        res.json(info);
      })
      .catch((err) => {
        console.log(err);
        res.status(500).send({
          error: "something went wrong",
        });
      });
  } catch (error) {
    console.error("Error generating embedded template:", error);
    res.status(500).json({ message: "Failed to retrieve embedded template" });
  }
});

app.get("/embed-dash-live-event(/:userId)", function (req, res) {
  try {
    const userId = req.params.userId;
    const templateData = {
      template: {
        values: {
          user_id: userId,
        },
      },
    };

    // Set your desired expiration for the generated workspace token.
    // Moesif's recommendation is to match or be larger than your user's session time while keeping time period less than 30 days.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 7);
    const expiration = tomorrow.toISOString();

    const moesif_url_live_event = `${moesifApiEndPoint}/v1/portal/~/workspaces/${templateWorkspaceIdLiveEvent}/access_token?expiration=${expiration}`;

    fetch(moesif_url_live_event, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${moesifManagementToken}`,
      },
      body: JSON.stringify(templateData),
    })
      .then((response) => {
        if (response.ok) {
          return response;
        } else {
          console.log("Api call to moesif not successful. server response is:");
          console.error(response.statusText);
          throw Error(response.statusText);
        }
      })
      .then((response) => {
        return response.json();
      })
      .then((info) => {
        res.json(info);
      })
      .catch((err) => {
        console.log(err);
        res.status(500).send({
          error: "something went wrong",
        });
      });
  } catch (error) {
    console.error("Error generating embedded template:", error);
    res.status(500).json({ message: "Failed to retrieve embedded template" });
  }
});

app.post('/stripe/checkout/sessions/:checkout_session_id', function (req, res) {
  // todo: verify auth0 or okta authentication

  fetch(`https://api.stripe.com/v1/checkout/sessions/${checkout_session_id}`, {
    headers: {
      'Authorization': `Bearer: ${process.env.STRIPE_KEY}`,
    }
  }).then(res => res.json())
  .then((result) => {
    if (result.customer && result.subscription) {
      // maybe await?
      // or we can respond and do it later.
      registerStripeCheckout(result);
    }
    // we still pass on result.
    res.status(201).json(result);
  }).catch((err) => {
    console.error("Error getting checkout session info from stripe", err);
    res.status(500).json({
      message: "Failed to retrieve checkout session info from stripe"
    })
  });
});

app.get('/stripe/customer', function (req, res) {
  // ideally use the auth0 or okta info directly get profile from based
  // current user.
  // or use another method verify email belong to the authorized user
  // since they should only able to get stripe customer data for themselves.
  const email = req.query && req.query.email
  fetch(`https://api.stripe.com/v1/customers/search?query=${encodeURIComponent(`email:"${email}"`)}`, {
    headers: {
      'Authorization': `Bearer: ${process.env.STRIPE_KEY}`,
    }
  }).then(res => res.json()).then((result) => {
    if (result.data && result.data[0]) {
      res.status(200).json(result.data[0]);
    } else {
      // not found
      // we can either use 404 or pass
      res.status(404).json('stripe customer not found');
    }
  }).catch((err) => {
    console.error("Error getting customer info from stripe", err);
    res.status(500).json({
      message: "Failed to retrieve customer info from stripe"
    })
  });
});


app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});

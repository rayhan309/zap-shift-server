const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 3000;
const stripe = require("stripe")(process.env.STRIPE_stripe);
const crypto = require("crypto");
const admin = require("firebase-admin");

const serviceAccount = require("./zap-shift-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// tracking id genaretor
function generateTrackingId() {
  const prefix = "PRCL"; // your brand prefix
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char random hex

  return `${prefix}-${date}-${random}`;
}

// meddleireffff
app.use(cors());
app.use(express.json());

// token varify
const varifyFirebaseToken = async (req, res, next) => {
  const authorization = req.headers.authorization;
  // console.log("authorization token", authorization);

  if (!authorization) {
    return res.status(401).send({ message: "invalid access" });
  }

  try {
    const firebaseToken = authorization.split(" ")[1];
    const varify = await admin.auth().verifyIdToken(firebaseToken);
    // console.log('firebase token verify', varify);

    req.user_email = varify.email;
    // console.log(varify, 'm,eddle wre');
  } catch (err) {
    return res.status(401).send({ message: "Unexpacted access" });
  }

  //  firebaseToken

  next();
};

// uri
const uri = process.env.DB_uri;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// main rout
async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    // my colections
    const myDB = client.db("zapShiftDB");
    const parcelColections = myDB.collection("parcelColections");
    const paymentCollections = myDB.collection("paymentCollections");
    const userCollections = myDB.collection("userCollections");
    const riderCollections = myDB.collection("riderCollections");

    // create users apis
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.userCreateAt = new Date();

      const query = { email: user.email };
      const userExsist = await userCollections.findOne(query);
      // console.log(userExsist);

      if (userExsist) {
        return res.send({ message: "this user alrady save" });
      }

      const result = await userCollections.insertOne(user);
      res.send(result);
    });

    // app.get('/users')

    // mongo db all parsel get
    app.get("/parcels", async (req, res) => {
      const { email } = req.query;
      const query = {};

      // set query
      if (email) {
        query.senderEmail = email;
      }

      const dateSort = { sendParcelDate: -1 };

      const result = await parcelColections
        .find(query)
        .sort(dateSort)
        .toArray();
      res.send(result);
    });

    app.get("/parcels/:parselId", async (req, res) => {
      const id = req.params.parselId;
      const query = { _id: new ObjectId(id) };
      // console.log(query);
      const result = await parcelColections.findOne(query);
      res.send(result);
    });

    // post db
    app.post("/parcels", async (req, res) => {
      const query = req.body;
      // date add
      query.sendParcelDate = new Date();
      const result = await parcelColections.insertOne(query);
      // console.log(result)
      res.send(result);
    });

    // delete methode
    app.delete("/parcels/:parcelId", async (req, res) => {
      const id = req.params.parcelId;
      const query = { _id: new ObjectId(id) };
      const result = await parcelColections.deleteOne(query);
      res.send(result);
    });

    // strip rileted apis
    app.post("/create-checkout-session-2", async (req, res) => {
      const parcelInfo = req.body;
      const amount = parseInt(parcelInfo.cost * 100);
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              unit_amount: amount,
              currency: "usd",
              product_data: {
                name: parcelInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: parcelInfo.senderEmail,
        metadata: {
          parcelId: parcelInfo.parcelId,
          parcelName: parcelInfo.parcelName,
        },
        success_url: `${process.env.SUCCESS_domain}/dashbords/success-full?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SUCCESS_domain}/cancel-full`,
      });

      res.send({ url: session.url });
      // console.log(parcelInfo, amount);
    });

    // payment seccess update
    app.patch("/payment-success", async (req, res) => {
      const { session_id } = req.query;

      if (session_id) {
        const session = await stripe.checkout.sessions.retrieve(session_id);

        const trackingId = generateTrackingId();

        if (session.payment_status === "paid") {
          const id = session.metadata.parcelId;
          const query = { _id: new ObjectId(id) };
          const update = {
            $set: {
              status: "paid",
              trackingId: trackingId,
            },
          };
          const result = await parcelColections.updateOne(query, update);

          // payment dada
          const paymentInfo = {
            amount: session.amount_total / 100,
            customerEmail: session.customer_email,
            paymentCurrency: session.currency,
            parcelId: session.metadata.parcelId,
            transactionId: session.payment_intent,
            paymentStatus: session.payment_status,
            payDate: new Date(),
            parcelName: session.metadata.parcelName,
            trackingId: trackingId,
          };

          // no tow call
          const transactionIdCheck = {
            transactionId: paymentInfo.transactionId,
          };

          const isExssist = await paymentCollections.findOne(
            transactionIdCheck
          );
          // console.log("is exssist", isExssist);

          if (isExssist) {
            return res.send({ message: "this payment alrady pay" });
          }

          if (session.payment_status === "paid") {
            const resultPayment = await paymentCollections.insertOne(
              paymentInfo
            );

            res.send({
              success: true,
              modifyParcel: result,
              trackingId: trackingId,
              transactionId: session.payment_intent,
              paymentInfo: resultPayment,
            });
          }

          // console.log("successfull update data", session);
          // res.send(result);
        }
      }

      // res.send({ Success: false });
    });

    app.get("/payments", varifyFirebaseToken, async (req, res) => {
      const user_email = req.user_email;
      const email = req.query.email;
      // console.log({user_email, email});

      const query = {};

      if (email) {
        query.customerEmail = email;
        // console.log(email);
        if (email !== user_email) {
          // console.log('scope', { user_email, email });
          return res.status(403).send({ message: "unexpackted access" });
        }
      }

      const result = await paymentCollections.find(query).toArray();
      res.send(result);
    });

    // reset
    // app.post("/create-checkout-session", async (req, res) => {
    //   const parcelInfo = req.body;
    //   const amount = parseInt(parcelInfo.cost) * 100;

    //   const session = await stripe.checkout.sessions.create({
    //     line_items: [
    //       {
    //         // Provide the exact Price ID (for example, price_1234) of the product you want to sell
    //         price_data: {
    //           currency: "USD",
    //           unit_amount: amount,
    //           product_data: {
    //             name: parcelInfo.parcelName,
    //           },
    //         },
    //         quantity: 1,
    //       },
    //     ],
    //     customer_email: parcelInfo.senderEmail,
    //     mode: "payment",
    //     metadata: { parcelId: parcelInfo.parcelId },
    //     success_url: `${process.env.SUCCESS_domain}/dashbords/payment-success`,
    //     cancel_url: `${process.env.SUCCESS_domain}/dashbords/payment-cancle`,
    //   });

    //   // console.log(session);
    //   res.send({ url: session.url });
    // });

    // rider reques
    app.post("/riders", async (req, res) => {
      const newRider = req.body;
      newRider.reqTime = new Date();
      newRider.status = "painding";
      // console.log(newRider);
      const email = req.query.email;
      // console.log(email)
      const query = { email: email };
      const rider = await riderCollections.findOne(query);

      if (rider) {
        return res.send({ message: "your req alrady send" });
      }

      const result = await riderCollections.insertOne(newRider);
      res.send(result);
    });

    app.get("/riders", async (req, res) => {
      const result = await riderCollections.find().toArray();
      res.send(result);
    });

    app.patch("/riders/:riderId", async (req, res) => {
      const id = req.params.riderId;
      const query = { _id: new ObjectId(id) };
      const { status } = req.body;
      const updateDoc = {
        $set: {
          status,
        },
      };

      const result = await riderCollections.updateOne(query, updateDoc);

      // console.log("id ", status);
      if (status === "selected") {
        const email = req.body.email;
        const emailQuery = {
          email,
        };
        const updateRiderRole = {
          $set: {
            role: "rider",
          },
        };

        const updateRole = await userCollections.updateOne(emailQuery, updateRiderRole)
        // console.log('done')
      }

      // const
      // console.log(email);

      res.send({result});
    });

    app.delete("/riders/:riderId", async (req, res) => {
      const id = req.params.riderId;
      const query = {_id: new ObjectId(id)};
      const result = await riderCollections.deleteOne(query);
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

// Basic routes
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "zap shift server" });
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

// app.all(/.*/, (req, res) => {
//  res.status(404).json({
//     status: 404,
//     error: "API not found",
//   });
// });

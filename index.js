//===================== dependencies import ====================//
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dotenv.config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

//===================== express app setup ====================//
const app = express();
const port = process.env.PORT || 3000;
//===================== middleware ====================//
app.use(cors({
  origin: "http://localhost:5173",
  credentials: true,
}));
app.use(express.json());
//===================== firebase admin setup ====================//
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
//===================== MongoDB connection string ====================//
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.sldyvva.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
//===================== main run function ====================//
async function run() {
  try {
    // await client.connect(); // MongoDB server এর সাথে connect
    //================= DB collections =================//
    const db = client.db("parcelDB");
    const usersCollection = db.collection("users");
    const parcelCollection = db.collection("parcels");
    const ridersCollection = db.collection("riders");
    const paymentCollection = db.collection("payments");
    //================= custom middlewares =================//
    // 🔹 Firebase token verify middleware
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res
          .status(401)
          .send({ message: "Unauthorized: No token provided" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res
          .status(401)
          .send({ message: "Unauthorized: No token provided" });
      }
      // verify the tocken
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res
          .status(403)
          .send({ message: "Forbidden: Invalid or expired token" });
      }
    };
    // 🔹 Verify admin middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req?.decoded?.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user?.role !== "admin") {
        return res
          .status(403)
          .send({ message: "Forbidden: No token provided" });
      }
      next();
    };
    // 🔹 Verify riders middleware
    const verifyRider = async (req, res, next) => {
      const email = req?.decoded?.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user?.role !== "rider") {
        return res
          .status(403)
          .send({ message: "Forbidden: No token provided" });
      }
      next();
    };
    //================= email sending APIs =================//
    const emailTransport = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SWIFT_EMAIL,
        pass: process.env.SWIFT_EMAIL_PASS,
      },
    });
    app.get("/send-payment-email", async (req, res) => {
      const paymentInfo = {
        transactionId: "aaaaaaaaa",
        user: "mdfuadamir@gmail.com",
        parcelInfo: "send 20 tk mango",
      };
      const emailObject = {
        from: `"Swiftdrop email sender" ${process.env.SWIFT_EMAIL}`,
        to: paymentInfo.user,
        subject: "swiftdrop parcel devivery confermation", // Subject line
        html: `<b>Thank you for the payment?</b>`, // html body
      };
      try {
        const emailInfo = await emailTransport.sendMail(emailObject);
        console.log("Message sent: %s", emailInfo.messageId);
        res.send({ result: "success" });
      } catch (err) {
        console.error("Error while sending mail", err);
        res.send({ result: "email failed" });
      }
    });
    //================= Users APIs =================//
    // 🔹 Get user role by email
    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;
        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }
        const user = await usersCollection.findOne({ email });
        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }
        res.send({ role: user.role || "user" });
      } catch (error) {
        res.status(500).send({ message: "Failed to get role" });
      }
    });
    // 🔹 Create user
    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        return res.status(200).send({
          success: false,
          message: "User already exists...",
        });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });
    app.get("/users/search", async (req, res) => {
      const emailQuery = req.query.email;
      if (!emailQuery) {
        return res.status(400).send({ message: "Missing email query" });
      }
      const regex = new RegExp(emailQuery, "i");
      try {
        const user = await usersCollection
          .find({ email: { $regex: regex } })
          .project({ email: 1, created_at: 1, role: 1 })
          .limit(10)
          .toArray();
        res.send(user);
      } catch (error) {
        res.status(500).send({ message: "Error Searcing User" });
      }
    });
    // 🔹 Update user role (Admin only)
    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { role } = req.body;
        if (!["admin", "user"].includes(role)) {
          return res.status(400).send({ message: "Invalide Role" });
        }
        try {
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } }
          );
          res.send({ message: `User role update to ${role}`, result });
        } catch (error) {
          res.status(500).send({ message: "Failed to Update user" });
        }
      }
    );
    //================= Parcels APIs =================//
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const { email, payment_status, delivery_status } = req.query;
        let query = {};
        if (email) {
          query = { created_by: email };
        }
        if (payment_status) {
          query.payment_status = payment_status;
        }
        if (delivery_status) {
          query.delivery_status = delivery_status;
        }
        const options = {
          sort: { creation_date: -1 },
        };
        const parcels = await parcelCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.log("Error Featching parcel:", error);
        res.status(500).send({ message: "Failed to get parcel" });
      }
    });

    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (error) {
        console.log("Error inserting parcel:", error);
        res.status(500).send({ message: "Failed to creat parcel" });
      }
    });
    // ✅ Delete a parcel by id
    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await parcelCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        console.log("Error deleting parcel:", error);
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });
    //================= Riders APIs =================//
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending"; // default
      rider.created_at = new Date().toISOString();
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });
    // 🔹 Get pending riders (admin only)
    app.get(
      "/riders/pending-riders",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const pendingRiders = await ridersCollection
            .find({ status: "pending" })
            .toArray();
          res.send(pendingRiders);
        } catch (error) {
          return res
            .status(500)
            .send({ message: "Failed to load pending riders" });
        }
      }
    );
    // 🔹 Get active riders (admin only)
    app.get(
      "/riders/active-riders",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const result = await ridersCollection
          .find({ status: "active" })
          .toArray();
        res.send(result);
      }
    );
    // 🔹 Update rider status (approve/reject)
    app.patch(
      "/riders/:id/status",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { status } = req.body;
        try {
          const rider = await ridersCollection.findOne({
            _id: new ObjectId(id),
          });
          if (!rider) {
            return res.status(404).send({ message: "Rider not found" });
          }
          const updatedDoc = { $set: { status } };
          const result = await ridersCollection.updateOne(
            { _id: new ObjectId(id) },
            updatedDoc
          );
          if (status === "active" && rider.email) {
            await usersCollection.updateOne(
              { email: rider.email },
              { $set: { role: "rider" } }
            );
          }
          res.send({ message: "Rider status updated", result });
        } catch (error) {
          console.log("Error status changing:", error);
          res.status(500).send({ message: "Failed to change status" });
        }
      }
    );

    // ✅ Assign Rider to Parcel
    app.get(
      "/riders/available",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { wirehouse } = req.query;
        try {
          const riders = await ridersCollection
            .find({
              wirehouse,
            })
            .toArray();
          res.send(riders);
        } catch (error) {
          res.status(500).send({ message: "Failed to loade rider" });
        }
      }
    );

    // ✅ Assign Rider to a Parcel
    app.patch(
      "/parcels/:id/assign",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const parcelId = req.params.id;
          const { riderId } = req.body;

          if (!ObjectId.isValid(parcelId) || !ObjectId.isValid(riderId)) {
            return res
              .status(400)
              .send({ message: "Invalid parcelId or riderId" });
          }
          const rider = await ridersCollection.findOne({
            _id: new ObjectId(riderId),
          });
          if (!rider) {
            return res.status(404).send({ message: "Rider not found" });
          }
          const parcelUpdate = await parcelCollection.updateOne(
            { _id: new ObjectId(parcelId) },
            {
              $set: {
                riderId: rider._id,
                riderName: rider.name,
                riderEmail: rider.email,
                assigned_rider: rider.email,
                riderContact: rider.contact,
                delivery_status: "rider_assigned",
                parcelStatus: "in_transit",
                updatedAt: new Date(),
              },
            }
          );

          if (parcelUpdate.modifiedCount === 0) {
            return res
              .status(404)
              .send({ message: "Parcel not found or not updated" });
          }

          await ridersCollection.updateOne(
            { _id: new ObjectId(riderId) },
            { $set: { status: "rider_assigned" } }
          );

          res.send({
            success: true,
            message: "Rider assigned successfully",
          });
        } catch (error) {
          console.error("Assign Rider error:", error);
          res.status(500).send({ message: "Failed to assign rider" });
        }
      }
    );

    app.get("/parcels/delivery/status-count", async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: "$delivery_status",
            count: {
              $sum: 1,
            },
          },
        },
        {
          $project: {
            status: "$_id",
            count: 1,
            _id: 0,
          },
        },
      ];
      const result = await parcelCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.get("/rider/parcels", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const email = req.query.email;
        if (!email) {
          return res.status(400).send({ message: "Rider email is required" });
        }
        const query = {
          riderEmail: email,
          delivery_status: { $in: ["rider_assigned", "in_transit"] },
        };
        const options = { sort: { created_at: -1 } };
        const parcels = await parcelCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Assign Rider error:", error);
        res.status(500).send({ message: "Failed to assign rider" });
      }
    });
    app.get(
      "/rider/completed-deliveries",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.query.email;
          if (!email) {
            return res.status(400).send({ message: "Rider email is required" });
          }
          const query = {
            riderEmail: email,
            delivery_status: { $in: ["delivered", "service_center_delivered"] },
          };
          const options = {
            sort: { created_at: -1 },
          };
          const completedDeliveries = await parcelCollection
            .find(query, options)
            .toArray();
          res.send(completedDeliveries);
        } catch (error) {
          console.error("Error loading completed parcels", error);
          res
            .status(500)
            .send({ message: "Failed to load completed Deliveries" });
        }
      }
    );
    app.patch(
      "/parcels/:id/cashout",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const id = req.params.id;
        const result = await parcelCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              cashout_status: "cashed_out",
              cashed_out_at: new Date(),
            },
          }
        );
        res.send(result);
      }
    );

    app.patch(
      "/parcels/:id/status",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const parcelId = req.params.id;
        const { status } = req.body;
        const updatedDoc = {
          delivery_status: status,
        };

        if (status === "in_transit") {
          updatedDoc.picked_at = new Date().toISOString();
        } else if (status === "delivered") {
          updatedDoc.delivered_at = new Date().toISOString();
        }

        try {
          const result = await parcelCollection.updateOne(
            { _id: new ObjectId(parcelId) },
            {
              $set: updatedDoc,
            }
          );
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to update status" });
        }
      }
    );
    //================= Tracking APIs =================//
    app.get("/parcel/:trackingId", async (req, res) => {
      const { trackingId } = req.params;
      try {
        const parcel = await parcelCollection.findOne({ trackingId });
        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }
        res.send(parcel);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Internal server error" });
      }
    });
    //================ Payments APIs =================//
    app.get("/payments", verifyFBToken, async (req, res) => {
      console.log("headers in payments", req.headers);
      try {
        const userEmail = req.query.email;
        // todo
        console.log("decoded", req.decoded);
        if (req.decoded.email !== userEmail) {
          return res
            .status(403)
            .send({ message: "Forbidden: No token provided" });
        }
        const query = userEmail ? { email: userEmail } : {};
        const payments = await paymentCollection
          .find(query)
          .sort({ paid_at: -1 })
          .toArray();
        res.send(payments);
      } catch (error) {
        console.error("Error fetching Payment history:", error.message);
        res.status(500).send({ message: "failed to get payments" });
      }
    });
    app.get("/parcels/:id", async (req, res) => {
      try {
        const parcelId = req.params.id;
        const query = { _id: new ObjectId(parcelId) };
        const result = await parcelCollection.findOne(query);
        res.status(201).send(result);
      } catch (error) {
        console.log("Error payment parcel:", error);
        res.status(500).send({ message: "Failed to payment parcel" });
      }
    });
    app.post("/create-payment-intent", async (req, res) => {
      try {
        const amountInCents = req.body.amountInCents;
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, amount, transactionId, email, paymentMethod } =
          req.body;
        const updateResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              payment_status: "paid",
              parcelStatus: "processing",
              updatedAt: new Date(),
            },
          }
        );
        if (updateResult.modifiedCount === 0) {
          return res
            .status(404)
            .send({ message: "parcel not found or already paid" });
        }

        const paymentDoc = {
          parcelId,
          amount,
          transactionId,
          email,
          paymentMethod,
          paid_at_string: new Date().toISOString(),
          paid_at: new Date(),
        };
        const paymentResult = await paymentCollection.insertOne(paymentDoc);
        res.status(201).send({
          massage: "payment recorded ans parcel marked as paid",
          insertedId: paymentResult.insertedId,
        });
      } catch (error) {
        console.error("Payment record error:", error.message);
        res.status(500).send({ success: false, error: error.message });
      }
    });

    //==========================  statistic stat =========================//
    // user state
    app.get("/user-stat/:email", verifyFBToken, async (req, res) => {
      try {
        const { email } = req.params;
        const parcels = await parcelCollection
          .find({ created_by: email })
          .toArray();
        const totalParcels = parcels.length;
        const deliveredParcels = parcels.filter(
          (p) => p.delivery_status === "delivered"
        ).length;
        const totalSpent = parcels.reduce((sum, p) => {
          if (p.payment_status === "paid") {
            return sum + (Number(p.cost) || 0);
          }
          return sum;
        }, 0);
        res.status(200).send({
          totalParcels,
          deliveredParcels,
          totalSpent,
        });
      } catch (error) {
        console.error("Error fetching user stats:", error);
        res.status(500).send({ message: "Server error fetching user stats." });
      }
    });
    // admin state
    app.get("/admin-stat", verifyFBToken, verifyAdmin, async (req, res) => {
      const totalUsers = await usersCollection.countDocuments();
      const totalParcels = await parcelCollection.countDocuments();
      const totalDelivered = await parcelCollection.countDocuments({
        delivery_status: "delivered",
      });
      const totalPayments = await paymentCollection
        .find({}, { projection: { amount: 1 } })
        .toArray();
      const totalRevenue = totalPayments.reduce(
        (sum, payment) => sum + (payment.amount || 0),
        0
      );
      const parcels = await parcelCollection
        .find(
          {},
          {
            projection: {
              SenderPickupWirehouse: 1,
              reciverPickupWirehouse: 1,
              cost: 1,
            },
          }
        )
        .toArray();
      let totalRiderEarnings = 0;
      parcels.forEach((parcel) => {
        const cost = Number(parcel.cost) || 0;
        if (!cost) return;

        if (parcel.SenderPickupWirehouse === parcel.reciverPickupWirehouse) {
          totalRiderEarnings += cost * 0.5;
        } else {
          totalRiderEarnings += cost * 0.8;
        }
      });
      const totalProfit = totalRevenue - totalRiderEarnings;
      res.status(200).send({
        totalUsers,
        totalParcels,
        totalDelivered,
        totalRevenue,
        totalProfit,
      });
    });

    // rider state
    app.get(
      "/rider-stat/:email",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const { email } = req.params;
        const parcels = await parcelCollection
          .find({ riderEmail: email })
          .toArray();

        const totalParcels = parcels.length;

        const delivered = parcels.filter(
          (p) => p.delivery_status === "delivered"
        ).length;

        const pending = parcels.filter(
          (p) => p.delivery_status !== "delivered"
        ).length;
        const totalEarnings = parcels.reduce((sum, p) => {
          const cost = Number(p.cost) || 0;
          const earning =
            p.SenderPickupWirehouse === p.reciverPickupWirehouse
              ? cost * 0.5
              : cost * 0.8;

          return sum + earning;
        }, 0);
        res.send({
          totalParcels,
          delivered,
          pending,
          totalEarnings,
        });
      }
    );

    //================= MongoDB connection test =================//
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);
//================= Simple root route =================//
app.get("/", (req, res) => {
  res.send("swiftdrop server is running");
});
//================= Start server =================//
app.listen(port, () => {
  console.log(`swiftdrop server is listening on port: ${port}`);
});

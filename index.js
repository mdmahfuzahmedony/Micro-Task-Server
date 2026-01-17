const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
require('dotenv').config();
// স্ট্রাইপ ইমপোর্ট
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// --- Middleware ---
app.use(express.json());
app.use(cors({
    origin: ["http://localhost:3000"], // আপনার ফ্রন্টএন্ড পোর্ট অনুযায়ী পরিবর্তন করতে পারেন
    credentials: true
}));

// --- MongoDB URI ---
const uri = "mongodb+srv://micro-task:JfnIEsZFzmdTCVIT@cluster0.awjlwox.mongodb.net/?appName=Cluster0";

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        const db = client.db("micro-task");
        const usersCollection = db.collection("allusers");
        const tasksCollection = db.collection("alltasks");
        const paymentsCollection = db.collection("payments");
        const submissionsCollection = db.collection("submissions");


        // ============================================================
        // ১. ইউজার রিলেটেড APIs
        // ============================================================

        // ইউজার রেজিস্ট্রেশন বা আপডেট (Upsert)
        app.post('/users', async (req, res) => {
            const user = req.body;
            const query = { email: user.email };
            const updateDoc = {
                $setOnInsert: {
                    createdAt: new Date(),
                    balance: user.role === 'worker' ? 10 : 0,
                },
                $set: {
                    name: user.name,
                    image: user.image,
                    role: user.role,
                }
            };
            const options = { upsert: true };
            const result = await usersCollection.updateOne(query, updateDoc, options);
            res.send(result);
        });

        // ইউজারের তথ্য ও ব্যালেন্স দেখা
        app.get('/users/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email: email };
            const result = await usersCollection.findOne(query);
            res.send(result);
        });

        // ============================================================
        // ২. বায়ার রিলেটেড APIs (Task Management)
        // ============================================================

        // নতুন টাস্ক অ্যাড করা (ব্যালেন্স চেক এবং বিয়োগ সহ)
        app.post('/add-task', async (req, res) => {
            const task = req.body;
            const total_payable_amount = parseInt(task.required_workers) * parseFloat(task.payable_amount);

            const user = await usersCollection.findOne({ email: task.buyer_email });
            if (!user || user.balance < total_payable_amount) {
                return res.status(400).send({ message: "Insufficient coins" });
            }

            const newTask = {
                ...task,
                total_payable_amount,
                required_workers: parseInt(task.required_workers),
                payable_amount: parseFloat(task.payable_amount),
                created_at: new Date(),
            };

            const insertResult = await tasksCollection.insertOne(newTask);

            const updateDoc = { $inc: { balance: -total_payable_amount } };
            const updateResult = await usersCollection.updateOne({ email: task.buyer_email }, updateDoc);

            res.send({ success: true, insertResult, updateResult });
        });

        app.get('/my-tasks/:email', async (req, res) => {
            const email = req.params.email;
            const query = { buyer_email: email };
            const result = await tasksCollection.find(query).sort({ created_at: -1 }).toArray();
            res.send(result);
        });

        // ============================================================
        // ৩. ওয়ার্কার রিলেটেড APIs
        // ============================================================

        app.get('/all-tasks', async (req, res) => {
            const query = { required_workers: { $gt: 0 } };
            const result = await tasksCollection.find(query).sort({ created_at: -1 }).toArray();
            res.send(result);
        });

        app.get('/task/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await tasksCollection.findOne(query);
            res.send(result);
        });

        // ============================================================
        // ৪. পেমেন্ট রিলেটেড APIs (Stripe & Coins)
        // ============================================================

        // ধাপ ১: পেমেন্ট ইনটেন্ট তৈরি করা
        app.post("/create-payment-intent", async (req, res) => {
            const { price } = req.body;
            if (!price || price <= 0) return res.status(400).send({ message: "Invalid price" });

            const amount = parseInt(price * 100); // সেন্টে রূপান্তর
            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amount,
                    currency: "usd",
                    payment_method_types: ["card"],
                });
                res.send({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // ধাপ ২: পেমেন্ট সফল হওয়ার পর রেকর্ড সেভ এবং কয়েন যোগ করা
        app.post("/payments", async (req, res) => {
            const payment = req.body;

            // ১. পেমেন্ট হিস্ট্রিতে ডাটা সেভ
            const paymentResult = await paymentsCollection.insertOne({
                email: payment.email,
                transactionId: payment.transactionId,
                price: payment.price,
                coins: parseInt(payment.coins),
                date: new Date()
            });

            // ২. ইউজারের ব্যালেন্স (Coins) আপডেট করা
            const filter = { email: payment.email };
            const updateDoc = {
                $inc: { balance: parseInt(payment.coins) }
            };
            const updateResult = await usersCollection.updateOne(filter, updateDoc);

            res.send({ paymentResult, updateResult });
        });

        // ধাপ ৩: ইউজারের পেমেন্ট হিস্ট্রি খুঁজে আনা
        app.get('/payment-history/:email', async (req, res) => {
            const email = req.params.email;
            const result = await paymentsCollection.find({ email: email }).sort({ date: -1 }).toArray();
            res.send(result);
        });


        // ============================================================
        // ৫. সাবমিশন রিলেটেড APIs
        // ============================================================

        // বায়ারের কাছে আসা পেন্ডিং সাবমিশনগুলো দেখা
        app.get('/pending-submissions/:email', async (req, res) => {
            const email = req.params.email;
            const query = { buyer_email: email, status: "pending" };
            const result = await submissionsCollection.find(query).toArray();
            res.send(result);
        });

        // এপ্রুভ করার লজিক
        app.patch('/approve-submission/:id', async (req, res) => {
            const id = req.params.id;
            const { worker_email, amount } = req.body;

            // ১. সাবমিশন স্ট্যাটাস 'approve' করা
            const filter = { _id: new ObjectId(id) };
            const updateSubmission = { $set: { status: "approve" } };
            await submissionsCollection.updateOne(filter, updateSubmission);

            // ২. ওয়ার্কারের ব্যালেন্স বাড়ানো
            const userFilter = { email: worker_email };
            const updateWorkerBalance = { $inc: { balance: parseFloat(amount) } };
            const result = await usersCollection.updateOne(userFilter, updateWorkerBalance);

            res.send(result);
        });

        // রিজেক্ট করার লজিক
        app.patch('/reject-submission/:id', async (req, res) => {
            const id = req.params.id;
            const { task_id } = req.body;

            // ১. সাবমিশন স্ট্যাটাস 'rejected' করা
            const filter = { _id: new ObjectId(id) };
            const updateSubmission = { $set: { status: "rejected" } };
            await submissionsCollection.updateOne(filter, updateSubmission);

            // ২. টাস্কের required_workers সংখ্যা ১ বাড়ানো
            const taskFilter = { _id: new ObjectId(task_id) };
            const updateTaskCount = { $inc: { required_workers: 1 } };
            await tasksCollection.updateOne(taskFilter, updateTaskCount);

            res.send({ success: true });
        });

        console.log("Database Connected & APIs Ready!");
    } catch (error) {
        console.error("Connection error:", error);
    }
}


// worker er kaj gula ei khane hobe 

// worker er home page er jnno 

// ১. ওয়ার্কারের স্ট্যাটাস (Stats) পাওয়ার API
app.get('/worker-stats/:email', async (req, res) => {
    const email = req.params.email;
    const query = { worker_email: email };
    
    // সব সাবমিশন সংখ্যা
    const totalSubmission = await submissionsCollection.countDocuments(query);
    
    // পেন্ডিং সাবমিশন সংখ্যা
    const totalPending = await submissionsCollection.countDocuments({ 
        worker_email: email, 
        status: "pending" 
    });

    // টোটাল আর্নিং (যেগুলো এপ্রুভ হয়েছে সেগুলোর যোগফল)
    const approvedSubmissions = await submissionsCollection.find({ 
        worker_email: email, 
        status: "approved" 
    }).toArray();

    const totalEarning = approvedSubmissions.reduce((sum, task) => sum + parseFloat(task.payable_amount), 0);

    res.send({
        totalSubmission,
        totalPending,
        totalEarning
    });
});

// ২. ওয়ার্কারের শুধুমাত্র এপ্রুভ হওয়া টাস্কের লিস্ট
app.get('/worker-approved-tasks/:email', async (req, res) => {
    const email = req.params.email;
    const query = { worker_email: email, status: "approved" };
    const result = await submissionsCollection.find(query).toArray();
    res.send(result);
});

run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Micro Task Server is running!');
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});